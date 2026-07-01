// The in-process Pi tool factories (memory / recall / summon). Heavy imports
// (Pi SDK, typebox) live here, loaded lazily via tools.ts's makePiTool — the
// registry itself stays cheap for the `gaia` CLI.

import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentDef } from "../core/types.js";
import { CORE_MEMORY_FILE, USER_MEMORY_FILE, type MemoryStore } from "../domain/memory.js";
import { searchTranscript, type RecallHit } from "../domain/recall.js";
import type { SummonCreate } from "../harness/spec.js";

const MEMORY_DESCRIPTION = [
  "Persist long-term notes for the current agent across sessions.",
  `Layout: ${CORE_MEMORY_FILE} (durable notes + index, always visible to you), ${USER_MEMORY_FILE} (what you know about the user, always visible), and topic files like debugging.md or agents/<id>.md (notes about another agent) that you read on demand.`,
  "Keep the always-visible files distilled; move detail into topic files and leave a one-line pointer. When a file nears its limit, consolidate instead of adding.",
  "Save durable facts, preferences, conventions, and lessons. Skip secrets, one-off details, and anything re-discoverable from the project.",
].join(" ");

export function createMemoryTool(store: MemoryStore, agent: AgentDef) {
  return defineTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_DESCRIPTION,
    promptSnippet: `memory: add, replace, or remove notes in your memory files (${CORE_MEMORY_FILE}, ${USER_MEMORY_FILE}, topic files); read and list topic files on demand.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("read"), Type.Literal("list")]),
      file: Type.Optional(Type.String({ description: `Memory file to act on, relative to your memory dir. Defaults to ${CORE_MEMORY_FILE}.` })),
      content: Type.Optional(Type.String({ description: "New memory content for add or replace." })),
      old_text: Type.Optional(Type.String({ description: "Exact existing text for replace or remove." })),
    }),
    execute: async (_toolCallId: string, params: { action: "add" | "replace" | "remove" | "read" | "list"; file?: string; content?: string; old_text?: string }) => {
      const file = params.file?.trim() || CORE_MEMORY_FILE;
      let text: string;
      let details: unknown;
      try {
        if (params.action === "list") {
          const files = await store.listFiles(agent.memoryDir);
          text = files.map((info) => `${info.file} (${info.chars}/${info.limit} chars)`).join("\n") || "no memory files";
          details = { files };
        } else if (params.action === "read") {
          const state = await store.readState(agent.memoryDir, file);
          text = state.content || `(empty: ${file})`;
          details = state;
        } else {
          const result = await store.mutate(agent.memoryDir, file, params.action, { content: params.content, oldText: params.old_text });
          text = `${result.ok ? "OK" : "ERROR"}: ${result.message}\n\n${result.state.content}`;
          details = result;
        }
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        details = { ok: false };
      }
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}

export function createRecallTool(transcriptPath: string, dbPath: string, roomId: string) {
  return defineTool({
    name: "recall",
    label: "Recall",
    description:
      "Search the full room history (every past session, not just your current context) for messages matching a query. Use when the conversation references something you do not remember - an earlier decision, a name, a discussion from weeks ago.",
    promptSnippet: `recall: full-text search over the complete ${roomId} room history.`,
    parameters: Type.Object({
      query: Type.String({ description: "Words or a phrase to search for." }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
      let text: string;
      let hits: RecallHit[] = [];
      try {
        hits = searchTranscript(transcriptPath, dbPath, params.query, params.limit ?? 8);
        text = hits.length
          ? hits.map((hit) => `[${hit.timestamp}]${hit.channel === "voice" ? " 🎙" : ""} ${hit.author}: ${hit.snippet}`).join("\n")
          : "no matches in the room history";
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: "text" as const, text }], details: { hits } };
    },
  });
}

const SUMMON_DESCRIPTION = [
  'Summon private worker agents ("whales") to handle tasks in separate sessions.',
  "Pass a single { agent, task } for one worker, or a `whales` list to fan out MANY workers IN PARALLEL.",
  "Each worker runs independently; its transcript stays private (not injected into the room) and it returns a compact result.",
  "Use this to decompose a goal and swarm it: cheap workers for reading/search/triage, heavy workers for reasoning, a codegen worker for large edits.",
].join(" ");

export function createSummonTool(summonCreate: SummonCreate, roomId: string) {
  return defineTool({
    name: "summon",
    label: "Summon",
    description: SUMMON_DESCRIPTION,
    promptSnippet: `summon: fan out private worker agents (whales) — one { agent, task } or a parallel \`whales\` list; returns each worker's final result.`,
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Single worker agent id to summon (e.g. whale-flash, whale-deep, whale-codex)." })),
      task: Type.Optional(Type.String({ description: "Task for the single summoned agent to complete." })),
      whales: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: "Worker agent id (e.g. whale-flash, whale-deep, whale-codex)." }),
            task: Type.String({ description: "Self-contained task with explicit acceptance criteria and exactly what to return." }),
          }),
          { description: "Fan out multiple workers in parallel. Each runs concurrently and returns its own result." },
        ),
      ),
    }),
    execute: async (_toolCallId: string, params: { agent?: string; task?: string; whales?: Array<{ agent: string; task: string }> }) => {
      const jobs =
        params.whales && params.whales.length > 0 ? params.whales : params.agent && params.task ? [{ agent: params.agent, task: params.task }] : [];

      if (jobs.length === 0) {
        const text = "ERROR: provide either { agent, task } or a non-empty `whales` list.";
        return { content: [{ type: "text" as const, text }], details: { ok: false, results: [] } };
      }

      // Fan out: every whale launches concurrently; awaiting them together runs
      // the swarm in parallel (bounded by the room's maxSummonsPerRoom cap).
      const settled = await Promise.all(
        jobs.map(async (job) => {
          try {
            const result = await summonCreate({ roomId, agentId: job.agent, task: job.task });
            return { agent: job.agent, result, ok: true };
          } catch (error) {
            return { agent: job.agent, result: `ERROR: ${error instanceof Error ? error.message : String(error)}`, ok: false };
          }
        }),
      );

      const text = settled.length === 1 ? settled[0].result : settled.map((entry) => `### @${entry.agent}\n${entry.result.trim()}`).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { ok: settled.every((entry) => entry.ok), results: settled } };
    },
  });
}
