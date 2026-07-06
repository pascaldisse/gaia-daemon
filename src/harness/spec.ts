// One descriptor per harness. Adding a harness = one `harness/<x>.ts` module
// calling `registerHarness(...)` at its bottom + one import line in the barrel
// (harness/index.ts). Nothing else learns the harness id: differences live as
// DATA on the spec (capabilities, ui, credentialProxy), read uniformly — never
// as `=== "claude"` branches. This rule is absolute (AGENTS.md §RULE #0).

import type { AgentDef, AgentEvent, CompactProgressUpdate, MessageAttachment, RoomEvent, Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import type { MemorySearchHit } from "../domain/workspace-index.js";
import type { ResolvedRole } from "../domain/roles.js";

// --- what a runtime consumes and produces ------------------------------------

export interface AgentInput {
  roomId: string;
  message: string;
  /** Files attached to the message (pasted into the composer). The shared
   * prompt builder lists them as path breadcrumbs for every harness; a
   * harness with a native image channel additionally attaches the bytes
   * (pi prompt images, claude stream-json image blocks, codex localImage
   * items) — its own translation, never a shared-code branch. */
  attachments?: MessageAttachment[];
  transcript: RoomEvent[];
  activeRole?: ResolvedRole;
  /** "voice" turns come from a live call: the reply is spoken aloud by TTS. */
  channel?: "text" | "voice";
  /** Per-turn thinking override (e.g. voice forcing it off). */
  thinking?: string;
  /** Auto-retrieved memory block for this turn ("" / absent = nothing cleared
   * the relevance gate). Turn-level overlay, never part of the session. */
  recall?: string;
  /** This turn is a raw harness-native command (e.g. "/deep-research ..."):
   * the harness hands `message` to its underlying CLI VERBATIM — no prompt
   * wrapping, no memory/transcript overlay — with its own skill/slash-command
   * surface enabled, so the CLI executes it as a command turn. Shared code only
   * sets this for harnesses that declare `supportsNativeCommands`; any other
   * harness ignores it and runs `message` as an ordinary turn. */
  nativeCommand?: boolean;
}

export interface AgentRuntime {
  readonly agent: AgentDef;
  readonly modelLabel: string;
  readonly capabilities: HarnessCapabilities;
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
  /** Inject guidance into the room's RUNNING turn (backs /steer). Resolves
   * false when there is nothing to steer. Only present when
   * capabilities.supportsSteer. */
  steer?(roomId: string, message: string): Promise<boolean>;
  /** Compact the room's session context using the HARNESS's own compaction
   * (backs /compact — gaia never re-implements summarization). Resolves with
   * a human-readable result line. `onProgress`, when supplied, receives whatever
   * token counts the harness can report as the pass runs (best-effort — a
   * harness that reports nothing just never calls it). Only present when
   * capabilities.supportsCompact. */
  compact?(roomId: string, onProgress?: (update: CompactProgressUpdate) => void): Promise<string>;
  dispose(): void;
  /** Drop the room's session so the next turn starts fresh (backs /clear). */
  resetRoom(roomId: string): void;
  /** Does a durable, resumable session for this room still exist? An agent's
   * transcript cursor promises "everything before me lives in the harness
   * session" — when the session is gone (crash, dropped handle, pruned store)
   * that promise is broken, and the turn loop must replay the history instead
   * of silently starting the agent mid-conversation. Absent ⇒ assume it does
   * (fail-safe: never spuriously reload). */
  hasDurableSession?(roomId: string): boolean;
}

// --- capabilities + ui (data on the spec) --------------------------------------

export type GaiaTool = "memory" | "recall" | "summon";

export interface HarnessCapabilities {
  /** Which gaia tools this harness can wire into a session; the agent's
   * configured tools are intersected with this. */
  readonly gaiaTools: readonly GaiaTool[];
  /** Harness-agnostic native capability tools this harness fulfils beyond the
   * base coding set — currently just `"web"` (claude: WebSearch+WebFetch;
   * codex: native Responses web_search; pi: the brave-search skill). Declared
   * as DATA here, unioned into the settings-UI tool vocabulary, and translated
   * locally by each harness — never an `=== "claude"` branch in shared code. */
  readonly nativeTools: readonly string[];
  /** Honors the granular per-tool array (read/write/edit/bash)? Codex is
   * coarse, so the UI hides the array there — derived, never id-branched. */
  readonly granularTools: boolean;
  /** Honors the `permissionMode` posture knob? */
  readonly supportsPermissionMode: boolean;
  /** Consumes the `mcpServers` config section (claude --mcp-config, codex
   * mcp_servers overrides)? The UI hides the section where unsupported. */
  readonly supportsMcp: boolean;
  /** Can inject guidance into a RUNNING turn (pi session.steer, codex
   * turn/steer)? Backs /steer; claude -p has no headless steering. */
  readonly supportsSteer: boolean;
  /** Has a native session-compaction the runtime can invoke (pi
   * session.compact, claude /compact, codex thread compaction)? Backs
   * /compact. */
  readonly supportsCompact: boolean;
  /** Passes an UNRECOGNIZED gaia slash command through to its underlying CLI as
   * a native command turn (claude runs it as a skill/slash-command with the
   * command surface enabled). Backs "/deep-research"-style passthrough, gated
   * per agent by AgentDef.nativeCommands. Harnesses with no such surface
   * (codex, pi) declare false and never receive one. Absent on a runtime double
   * ⇒ treated as false. */
  readonly supportsNativeCommands: boolean;
  /** The harness's OWN subagent/fan-out tool names (claude: Task/Agent/
   * Workflow). gaia has exactly ONE fan-out primitive — the summon tool: every
   * worker gets a visible sub-room, a durable resumable turn, the sandbox +
   * trust tier, and result callback into the calling room. A harness's native
   * fan-out would spawn OPAQUE workers inside the harness process (invisible,
   * unresumable, blocking the room thread), so each harness declares the tools
   * here as data and its own runtime suppresses them on every turn — never an
   * id branch in shared code. Empty when the harness has no such surface. */
  readonly fanOutTools: readonly string[];
}

/** A native (passthrough) slash command a harness advertises for the composer's
 * `/`-autocomplete. Best-effort + non-exhaustive: passthrough forwards ANY
 * unrecognized command, so an absent entry only means "not hinted", never
 * "unavailable". */
export interface NativeCommandDef {
  name: string;
  description: string;
}

export interface HarnessUi {
  label: string;
  description: string;
  /** Lock the model provider (hides the provider selector). */
  lockedProvider?: string;
  /** Filter model options to these provider ids. */
  modelProviderIds?: string[];
  /** Offer exactly these model names (harnesses with their own aliases). */
  modelNameOptions?: string[];
}

// --- daemon bridge (what subprocess harnesses use for tool-IO) ------------------

export interface HarnessHost {
  baseUrl: string;
  /** Mount of the in-daemon LLM credential proxy. */
  llmProxyUrl: string;
  mintToken(claims: { agentId: string; roomId: string }): string;
}

/** Uniform construction context; each spec's `create` picks what it needs. */
export interface RuntimeCreateContext {
  workspace: Workspace;
  agent: AgentDef;
  memoryStore: MemoryStore;
  /** In-process summon entry (Pi tools); absent when summoning is not allowed. */
  summonCreate?: SummonCreate;
  /** Daemon bridge for subprocess harnesses' memory/recall/summon CLI. */
  harnessHost?: HarnessHost;
  /** Hybrid memory search (facts + episodes + room history), daemon-side. */
  recallSearch?: RecallSearch;
}

/** Search long-term memory; hits are pre-ranked (see domain/workspace-index).
 * `scroll` (optional capability) pages the raw transcript around a prior
 * transcript hit id — the deep path's no-LLM pager (§8). */
export interface RecallSearch {
  (query: string, limit?: number): Promise<MemorySearchHit[]>;
  scroll?(hitId: number, options?: { span?: number; offset?: number }): Promise<string>;
}

/** Create a background summon from inside a turn. Resolves IMMEDIATELY with a
 * launch acknowledgment (never the result — a summon must not block the
 * calling turn); the worker's result is delivered back into the calling room
 * by the summon coordinator when it settles, re-invoking the caller. */
export interface SummonCreate {
  (params: { roomId: string; agentId: string; task: string }): Promise<string>;
}

// --- credential proxy wiring (data, applied uniformly by RunnerHost) ------------

export interface CredentialProxyContext {
  proxyUrl: string;
  token: string;
  /** Per-room writable scratch dir a harness may relocate its cred store into. */
  scratchDir: string;
}

export interface CredentialProxyWiring {
  env?: Record<string, string>;
  /** Extra paths to deny-read in the sandbox (this harness's real cred store). */
  denyRead?: string[];
}

// --- the spec + registry ----------------------------------------------------------

export interface HarnessSpec {
  id: string;
  capabilities: HarnessCapabilities;
  ui: HarnessUi;
  create(ctx: RuntimeCreateContext): AgentRuntime;
  credentialProxy?(ctx: CredentialProxyContext): CredentialProxyWiring;
  /** A-priori context window (tokens) for one of this harness's models, used by
   * the context-gate warning BEFORE a turn runs (the harness only reports the
   * real window mid-turn). Data on the spec, read uniformly — never id-branched.
   * Undefined when the harness can't say, so the UI shows tokens without a %. */
  contextWindow?(model: string | undefined): number | undefined;
  /** Native passthrough commands this harness advertises for `/`-autocomplete
   * (claude: its discoverable skills/commands). Data on the spec, read uniformly
   * by the snapshot builder and unioned into the command palette only for agents
   * that opted into nativeCommands. Non-exhaustive by design (see
   * NativeCommandDef). Absent ⇒ the harness advertises none. */
  nativeCommands?(): NativeCommandDef[];
  /** Does a durable session handle for (room, agent) survive on disk? Answered
   * from the harness's own persistence (claude/codex harness-sessions.json, pi
   * session files) WITHOUT spawning anything — a fresh daemon process is
   * exactly the case that matters. Read uniformly by RunnerHost.hasDurableSession
   * before a turn: false with a deep cursor ⇒ the conversation behind the
   * cursor is gone and must be replayed (through the context gate when large).
   * Absent ⇒ sessions are not detectable a-priori; treated as present. */
  hasDurableSession?(rootDir: string, roomId: string, agentId: string): boolean;
}

const registry = new Map<string, HarnessSpec>();

export function registerHarness(spec: HarnessSpec): void {
  registry.set(spec.id, spec);
}

export function harnessSpecs(): HarnessSpec[] {
  return [...registry.values()];
}

export function findHarness(id: string): HarnessSpec | undefined {
  return registry.get(id);
}

export function harnessSpecFor(id: string): HarnessSpec {
  const spec = registry.get(id);
  if (!spec) throw new Error(`Unsupported harness: ${id}`);
  return spec;
}

export function capabilitiesFor(id: string): HarnessCapabilities {
  const spec = registry.get(id) ?? registry.get("pi");
  if (!spec) throw new Error("No harnesses registered");
  return spec.capabilities;
}

/** A-priori context window for a harness/model, or undefined when unknown.
 * Read uniformly by the context gate — each harness declares its own. */
export function contextWindowFor(id: string, model: string | undefined): number | undefined {
  return registry.get(id)?.contextWindow?.(model);
}

/** Native passthrough commands a harness advertises for autocomplete ([] when
 * none / unregistered). Read uniformly by the snapshot builder. */
export function nativeCommandsFor(id: string): NativeCommandDef[] {
  return registry.get(id)?.nativeCommands?.() ?? [];
}

/** The single harness parser: valid iff registered. */
export function parseHarness(raw: unknown): string | undefined {
  return typeof raw === "string" && registry.has(raw) ? raw : undefined;
}

/** Effective harness for an agent in a workspace: agent → workspace → "pi". */
export function harnessIdFor(agent: AgentDef, workspace: Workspace): string {
  return agent.harness ?? workspace.config.harness ?? "pi";
}
