// The single registry of GAIA daemon tools (memory / recall / summon). Before
// this, each tool's id + per-tool constants were re-encoded in ~6 places — the
// Pi in-process tools, the Claude permission grants, the system-prompt CLI
// pointer, the `gaia` CLI dispatch, and the settings list — which had already
// drifted (the settings list was missing `summon`). Add a tool = one entry here
// and it appears in-process, as a Claude grant, in the system prompt, in the
// CLI dispatch, and in the settings UI at once.
//
// Import weight: this module pulls NOTHING heavy at load (all type-only imports
// plus node:path). The Pi SDK is loaded lazily inside makePiTool, so the
// lightweight `gaia` CLI (cli-harness.ts) can import the registry for its verb
// dispatch without paying for pi-coding-agent.

import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { GaiaTool } from "../runtime/capabilities.js";
import type { SummonCreate } from "./summon-tool.js";

/** Everything the in-process Pi tool factories might need; each tool picks what it uses. */
export interface PiToolContext {
  memoryStore: MemoryStore;
  agent: AgentDefinition;
  roomId: string;
  roomDir: string;
  summonCreate?: SummonCreate;
}

export interface GaiaToolSpec {
  id: GaiaTool;
  /** `gaia` CLI verbs that dispatch to this tool; the first is canonical. */
  cliVerbs: string[];
  /** Claude `--allowedTools` permission grant (narrow, locked `gaia` CLI prefix). */
  grant: string;
  /** One-line system-prompt pointer, shown when the agent has this tool. */
  pointer: string;
  /**
   * Build the in-process Pi tool, or null when its dependencies are unavailable
   * (e.g. summon without a summonCreate). The Pi SDK is imported lazily here so
   * the registry stays cheap for non-Pi importers.
   */
  makePiTool(ctx: PiToolContext): Promise<unknown | null>;
}

export const GAIA_TOOLS: GaiaToolSpec[] = [
  {
    id: "memory",
    cliVerbs: ["mem", "memory"],
    grant: "Bash(gaia mem:*)",
    pointer: "- `gaia mem list|read|add|replace|remove` — your persistent memory",
    makePiTool: async (ctx) => (await import("./memory-tool.js")).createMemoryTool(ctx.memoryStore, ctx.agent),
  },
  {
    id: "recall",
    cliVerbs: ["recall"],
    grant: "Bash(gaia recall:*)",
    pointer: "- `gaia recall <query>` — full-text search of the room history",
    makePiTool: async (ctx) =>
      (await import("./recall-tool.js")).createRecallTool(join(ctx.roomDir, "transcript.jsonl"), join(ctx.roomDir, "recall.db"), ctx.roomId),
  },
  {
    id: "summon",
    cliVerbs: ["summon"],
    grant: "Bash(gaia summon:*)",
    pointer: '- `gaia summon <agent> "<task>"` — run a private worker agent (visible live in the summons drawer)',
    makePiTool: async (ctx) =>
      ctx.summonCreate ? (await import("./summon-tool.js")).createSummonTool(ctx.summonCreate, ctx.roomId) : null,
  },
];

const byId = new Map(GAIA_TOOLS.map((tool) => [tool.id, tool]));
const byVerb = new Map(GAIA_TOOLS.flatMap((tool) => tool.cliVerbs.map((verb) => [verb, tool] as const)));

export function gaiaToolIds(): GaiaTool[] {
  return GAIA_TOOLS.map((tool) => tool.id);
}

export function gaiaToolFor(id: string): GaiaToolSpec | undefined {
  return byId.get(id as GaiaTool);
}

export function gaiaToolByVerb(verb: string): GaiaToolSpec | undefined {
  return byVerb.get(verb);
}

/** Build every in-process Pi tool the agent has enabled (dropping unavailable ones). */
export async function buildPiTools(enabled: string[], ctx: PiToolContext): Promise<unknown[]> {
  const built = await Promise.all(GAIA_TOOLS.filter((tool) => enabled.includes(tool.id)).map((tool) => tool.makePiTool(ctx)));
  return built.filter((tool) => tool !== null);
}
