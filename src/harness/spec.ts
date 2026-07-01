// One descriptor per harness. Adding a harness = one `harness/<x>.ts` module
// calling `registerHarness(...)` at its bottom + one import line in the barrel
// (harness/index.ts). Nothing else learns the harness id: differences live as
// DATA on the spec (capabilities, ui, credentialProxy), read uniformly — never
// as `=== "claude"` branches. This rule is absolute (AGENTS.md §RULE #0).

import type { AgentDef, AgentEvent, RoomEvent, Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import type { MemorySearchHit } from "../domain/memory-index.js";
import type { ResolvedRole } from "../domain/roles.js";

// --- what a runtime consumes and produces ------------------------------------

export interface AgentInput {
  roomId: string;
  message: string;
  transcript: RoomEvent[];
  activeRole?: ResolvedRole;
  /** "voice" turns come from a live call: the reply is spoken aloud by TTS. */
  channel?: "text" | "voice";
  /** Per-turn thinking override (e.g. voice forcing it off). */
  thinking?: string;
  /** Auto-retrieved memory block for this turn ("" / absent = nothing cleared
   * the relevance gate). Turn-level overlay, never part of the session. */
  recall?: string;
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
  dispose(): void;
  /** Drop the room's session so the next turn starts fresh (backs /clear). */
  resetRoom(roomId: string): void;
}

// --- capabilities + ui (data on the spec) --------------------------------------

export type GaiaTool = "memory" | "recall" | "summon";

export interface HarnessCapabilities {
  /** Which gaia tools this harness can wire into a session; the agent's
   * configured tools are intersected with this. */
  readonly gaiaTools: readonly GaiaTool[];
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

/** Search long-term memory; hits are pre-ranked (see domain/memory-index). */
export interface RecallSearch {
  (query: string, limit?: number): Promise<MemorySearchHit[]>;
}

/** Create a summon from inside a turn; resolves with the worker's final reply. */
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

/** The single harness parser: valid iff registered. */
export function parseHarness(raw: unknown): string | undefined {
  return typeof raw === "string" && registry.has(raw) ? raw : undefined;
}

/** Effective harness for an agent in a workspace: agent → workspace → "pi". */
export function harnessIdFor(agent: AgentDef, workspace: Workspace): string {
  return agent.harness ?? workspace.config.harness ?? "pi";
}
