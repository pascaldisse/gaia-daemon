// The in-process Pi tool factories (memory / recall / summon). Heavy imports
// (Pi SDK, typebox) live here, loaded lazily via tools.ts's makePiTool — the
// registry itself stays cheap for the `gaia` CLI.

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { workspaceRootFromRoomDir } from "../core/paths.js";
import type { AgentDef } from "../core/types.js";
import { CORE_MEMORY_FILE, USER_MEMORY_FILE, type MemoryStore } from "../domain/memory.js";
import { bareWorkspaceRecall, formatMemoryHits, scrollTranscriptWindow, type MemorySearchHit } from "../domain/workspace-index.js";
import type { RecallSearch, SummonCreate } from "../harness/spec.js";
import type { AgentRosterEntry } from "./tools.js";

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
      action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("read"), Type.Literal("list"), Type.Literal("batch")]),
      file: Type.Optional(Type.String({ description: `Memory file to act on, relative to your memory dir. Defaults to ${CORE_MEMORY_FILE}.` })),
      content: Type.Optional(Type.String({ description: "New memory content for add or replace." })),
      old_text: Type.Optional(Type.String({ description: "Exact existing text for replace or remove." })),
      operations: Type.Optional(
        Type.Array(
          Type.Object({
            action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
            content: Type.Optional(Type.String()),
            old_text: Type.Optional(Type.String()),
          }),
          { description: "Batch mode: apply ALL operations to one file atomically, validated together against the file's budget — use this to consolidate (several replaces + removes) in ONE call instead of retrying op-by-op." },
        ),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action: "add" | "replace" | "remove" | "read" | "list" | "batch";
        file?: string;
        content?: string;
        old_text?: string;
        operations?: Array<{ action: "add" | "replace" | "remove"; content?: string; old_text?: string }>;
      },
    ) => {
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
        } else if (params.action === "batch" || params.operations?.length) {
          const operations = (params.operations ?? []).map((op) => ({
            action: op.action,
            ...(op.content !== undefined ? { content: op.content } : {}),
            ...(op.old_text !== undefined ? { oldText: op.old_text } : {}),
          }));
          const result = await store.mutateBatch(agent.memoryDir, file, operations);
          text = `${result.ok ? "OK" : "ERROR"}: ${result.message}\n\n${result.state.content}`;
          details = result;
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

/** Fallback recall when no daemon bridge exists: the workspace memory index
 * opened directly (lexical-only, whole workspace — v3's per-room recall.db
 * fallback retired with the rest of the v3 engine). */
export function localRecallSearch(roomDir: string, _roomId: string, agent?: { id: string; memoryDir: string }): RecallSearch {
  const root = workspaceRootFromRoomDir(roomDir);
  const search = async (query: string, limit?: number) =>
    bareWorkspaceRecall(root, query, {
      ...(agent ? { agentId: agent.id, memoryDir: agent.memoryDir } : {}),
      limit: limit ?? 8,
    });
  return Object.assign(search, {
    scroll: async (hitId: number, options?: { span?: number; offset?: number }) =>
      (await scrollTranscriptWindow(root, hitId, options ?? {})) ?? `no transcript hit with id ${hitId} — ids come from recall results ("hit N")`,
  });
}

export function createRecallTool(search: RecallSearch, roomId: string) {
  return defineTool({
    name: "recall",
    label: "Recall",
    description:
      "Search your long-term memory: distilled facts, past task episodes (with outcomes), and the full history of EVERY room — every past session, not just your current context. Use when the conversation references something you do not remember: an earlier decision, a name, a lesson from a failed attempt, a discussion from weeks ago. To read the raw conversation around a transcript result, call again with `around` set to that hit's id.",
    promptSnippet: `recall: deep ranked search over your facts, episodes, and all room history (not just ${roomId}); pass around=<hit id> to scroll the raw transcript at a hit.`,
    parameters: Type.Object({
      query: Type.String({ description: "Words or a phrase to search for (ignored when `around` is set)." }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
      around: Type.Optional(Type.Number({ description: "Scroll mode: a transcript hit id from a previous recall — returns the raw conversation around it." })),
      span: Type.Optional(Type.Number({ description: "Scroll window: events each side of the hit (default 12)." })),
      offset: Type.Optional(Type.Number({ description: "Scroll shift: move the window by this many events (negative = earlier)." })),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number; around?: number; span?: number; offset?: number }) => {
      let text: string;
      let hits: MemorySearchHit[] = [];
      try {
        if (params.around !== undefined && search.scroll) {
          text = await search.scroll(params.around, {
            ...(params.span !== undefined ? { span: params.span } : {}),
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
          });
        } else {
          hits = await search(params.query, params.limit ?? 8);
          text = hits.length ? formatMemoryHits(hits, { full: true }) : "no matches in memory or room history";
        }
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: "text" as const, text }], details: { hits } };
    },
  });
}

const SUMMON_DESCRIPTION = [
  'Summon background worker agents ("whales") to handle tasks in their own sub-rooms.',
  "Pass a single { agent, task } for one worker, or a `whales` list to fan out MANY workers IN PARALLEL.",
  "This tool returns IMMEDIATELY with each worker's sub-room id — workers run in the background and never block your turn.",
  "When a worker finishes, its result is posted back into this room and you are invoked again to continue — do NOT wait, poll, or re-summon while workers run.",
  "Use this to decompose a goal and swarm it: cheap workers for reading/search/triage, heavy workers for reasoning, a codegen worker for large edits; end your turn after summoning (tell the user what you launched) and synthesize when the results come back.",
].join(" ");

export function createSummonTool(summonCreate: SummonCreate, roomId: string, availableAgents: readonly AgentRosterEntry[] = []) {
  const availableAgentIds = availableAgents.map((agent) => agent.id);
  const rosterLine = availableAgentIds.length ? `Available agents: ${availableAgentIds.join(", ")}` : "";
  const agentParameter = () => {
    const description = ["Worker agent id to summon.", rosterLine].filter(Boolean).join(" ");
    return availableAgentIds.length ? Type.Enum(availableAgentIds, { description }) : Type.String({ description });
  };

  return defineTool({
    name: "summon",
    label: "Summon",
    description: [SUMMON_DESCRIPTION, rosterLine].filter(Boolean).join(" "),
    promptSnippet: [
      `summon: fan out background worker agents (whales) — one { agent, task } or a parallel \`whales\` list; returns immediately, and each worker's result is posted back to this room when it finishes (you'll be invoked again — never block on workers).`,
      rosterLine,
    ]
      .filter(Boolean)
      .join(" "),
    parameters: Type.Object({
      agent: Type.Optional(agentParameter()),
      task: Type.Optional(Type.String({ description: "Task for the single summoned agent to complete." })),
      whales: Type.Optional(
        Type.Array(
          Type.Object({
            agent: agentParameter(),
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
