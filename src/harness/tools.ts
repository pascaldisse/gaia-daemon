// The single registry of GAIA daemon tools (memory / recall / summon). Add a
// tool = one entry here and it appears in-process (Pi), as a Claude grant, in
// the system-prompt pointer, in the `gaia` CLI dispatch, and in the settings
// UI at once.
//
// Import weight: nothing heavy at load — the Pi SDK + typebox factories live
// in tools-pi.ts and are imported lazily, so the lightweight `gaia` CLI can
// use the registry for verb dispatch without paying for pi-coding-agent.

import type { AgentDef, Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import type { GaiaTool, RecallSearch, SummonCreate } from "../harness/spec.js";

/** Everything the in-process Pi tool factories might need. */
export interface AgentRosterEntry {
  id: string;
  label: string;
}

/** Live state available to every registry pointer. Keep this as one object so
 * future dynamic documentation can grow without changing pointer signatures. */
export interface PointerContext {
  availableAgents: readonly AgentRosterEntry[];
}

/** One derivation from the loaded workspace feeds prompt pointers, native tool
 * schemas, and the read-only harness roster endpoint. */
export function agentRoster(workspace: Pick<Workspace, "agents">): AgentRosterEntry[] {
  return Object.values(workspace.agents).map((agent) => ({ id: agent.id, label: agent.displayName }));
}

export interface PiToolContext {
  memoryStore: MemoryStore;
  agent: AgentDef;
  roomId: string;
  roomDir: string;
  /** Live workspace roster used to constrain self-describing tool schemas. */
  availableAgents?: readonly AgentRosterEntry[];
  summonCreate?: SummonCreate;
  /** Daemon-side hybrid search; absent → the tool falls back to the local
   * transcript index (works without a bridge, lexical room-only). */
  recallSearch?: RecallSearch;
}

export interface GaiaToolSpec {
  id: GaiaTool;
  /** `gaia` CLI verbs that dispatch to this tool; the first is canonical. */
  cliVerbs: string[];
  /** Claude `--allowedTools` permission grant (narrow, locked CLI prefix). */
  grant: string;
  /** System-prompt pointer shown when the agent has this tool. Static docs stay
   * strings; docs using live state derive from the uniform pointer context. */
  pointer: string | ((context: PointerContext) => string);
  /** Build the in-process Pi tool, or null when unavailable (lazy import). */
  makePiTool(ctx: PiToolContext): Promise<unknown | null>;
}

export const GAIA_TOOLS: GaiaToolSpec[] = [
  {
    id: "memory",
    cliVerbs: ["mem", "memory"],
    grant: "Bash(gaia mem:*)",
    pointer: "- `gaia mem list|read|add|replace|remove|batch` — your persistent memory (batch = several edits to one file, atomic, validated together)",
    makePiTool: async (ctx) => (await import("./tools-pi.js")).createMemoryTool(ctx.memoryStore, ctx.agent),
  },
  {
    id: "recall",
    cliVerbs: ["recall"],
    grant: "Bash(gaia recall:*)",
    pointer: "- `gaia recall <query>` — deep memory search (every room + your facts/episodes, semantically reranked); `gaia recall --around <hitId>` scrolls the raw transcript around a hit",
    makePiTool: async (ctx) => {
      const factory = await import("./tools-pi.js");
      return factory.createRecallTool(
        ctx.recallSearch ?? factory.localRecallSearch(ctx.roomDir, ctx.roomId, { id: ctx.agent.id, memoryDir: ctx.agent.memoryDir }),
        ctx.roomId,
      );
    },
  },
  {
    id: "summon",
    cliVerbs: ["summon"],
    grant: "Bash(gaia summon:*)",
    pointer: ({ availableAgents }) =>
      [
        '- `gaia summon [--worktree] <agent> "<task>"` — spin up a background worker agent in its own sub-room (nested under this room in the sidebar); `--worktree` requests a separate checkout when worktree isolation is configured; returns immediately, and when the worker finishes its result is posted back to this room and you are invoked to continue — never wait or poll for it',
        availableAgents.length ? `Available agents: ${availableAgents.map((agent) => agent.id).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    makePiTool: async (ctx) =>
      ctx.summonCreate
        ? (await import("./tools-pi.js")).createSummonTool(ctx.summonCreate, ctx.roomId, ctx.availableAgents)
        : null,
  },
  {
    id: "resume",
    cliVerbs: ["resume"],
    grant: "Bash(gaia resume:*)",
    pointer:
      '- `gaia resume <roomId> "<message>"` — send a follow-up message into an existing sub-room to resume/steer its worker: steers if it is mid-turn, starts a fresh turn if idle',
    makePiTool: async () => null,
  },
];

/** The GaiaTool ids denied to an agent in an incognito room: `memory` (its
 * persistent core memory) and `recall` (long-term memory + room-history search).
 * `summon` is intentionally kept — it spawns a worker, it doesn't read or write
 * this room's memory. */
export const INCOGNITO_STRIPPED_TOOLS: readonly GaiaTool[] = ["memory", "recall"];

/** Remove the incognito-stripped memory tools from an agent's vocabulary,
 * returning the SAME agent when it has none of them. Applied ONCE in the runner
 * (harness/runner.ts) so every harness's create() reads the already-filtered
 * `agent.tools` — RULE #0: one uniform mechanism, no per-harness branch. */
export function stripIncognitoTools(agent: AgentDef): AgentDef {
  const strip = new Set<string>(INCOGNITO_STRIPPED_TOOLS);
  if (!agent.tools.some((tool) => strip.has(tool))) return agent;
  return { ...agent, tools: agent.tools.filter((tool) => !strip.has(tool)) };
}

const byVerb = new Map(GAIA_TOOLS.flatMap((tool) => tool.cliVerbs.map((verb) => [verb, tool] as const)));

export function gaiaToolIds(): GaiaTool[] {
  return GAIA_TOOLS.map((tool) => tool.id);
}

export function gaiaToolByVerb(verb: string): GaiaToolSpec | undefined {
  return byVerb.get(verb);
}

/** Build every in-process Pi tool the agent has enabled (dropping unavailable ones). */
export async function buildPiTools(enabled: string[], ctx: PiToolContext): Promise<unknown[]> {
  const built = await Promise.all(GAIA_TOOLS.filter((tool) => enabled.includes(tool.id)).map((tool) => tool.makePiTool(ctx)));
  return built.filter((tool) => tool !== null);
}
