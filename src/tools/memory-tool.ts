import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "../agents/types.js";
import { CORE_MEMORY_FILE, USER_MEMORY_FILE, type MemoryStore } from "../memory/memory-store.js";

const DESCRIPTION = [
  "Persist long-term notes for the current agent across sessions.",
  `Layout: ${CORE_MEMORY_FILE} (durable notes + index, always visible to you), ${USER_MEMORY_FILE} (what you know about the user, always visible), and topic files like debugging.md or agents/<id>.md (notes about another agent) that you read on demand.`,
  "Keep the always-visible files distilled; move detail into topic files and leave a one-line pointer. When a file nears its limit, consolidate instead of adding.",
  "Save durable facts, preferences, conventions, and lessons. Skip secrets, one-off details, and anything re-discoverable from the project.",
].join(" ");

export function createMemoryTool(store: MemoryStore, agent: AgentDefinition) {
  return defineTool({
    name: "memory",
    label: "Memory",
    description: DESCRIPTION,
    promptSnippet: `memory: add, replace, or remove notes in your memory files (${CORE_MEMORY_FILE}, ${USER_MEMORY_FILE}, topic files); read and list topic files on demand.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("replace"),
        Type.Literal("remove"),
        Type.Literal("read"),
        Type.Literal("list"),
      ]),
      file: Type.Optional(
        Type.String({ description: `Memory file to act on, relative to your memory dir. Defaults to ${CORE_MEMORY_FILE}.` }),
      ),
      content: Type.Optional(Type.String({ description: "New memory content for add or replace." })),
      old_text: Type.Optional(Type.String({ description: "Exact existing text for replace or remove." })),
    }),
    execute: async (_toolCallId, params) => {
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
          const result = await store.mutate(agent.memoryDir, file, params.action, {
            content: params.content,
            oldText: params.old_text,
          });
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
