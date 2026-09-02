// ---------------------------------------------------------------------------
// Agents (agent.json + resolved paths)

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentModelConfig {
  provider?: string;
  name?: string;
}

// Memory v3 (MEMORY-DESIGN.md): auto-recall, embeddings, consolidation.
// Workspace config resolves to a full MemoryConfig over the defaults; agents
// may override any subset via agent.json's `memory` patch.
export interface MemoryEmbeddingsProviderConfig {
  provider: string;
  model?: string;
  baseUrl?: string;
  envKey?: string;
}

export interface MemoryConsolidateConfig {
  enabled: boolean;
  idleMinutes: number;
  maxPerDay: number;
  /** Consolidation model; unset = the agent's own model. */
  model?: AgentModelConfig;
}

export interface MemoryConfig {
  autoRecall: boolean;
  autoRecallBudget: number;
  embeddings: "auto" | "off" | MemoryEmbeddingsProviderConfig;
  /** Deep-path reranker (local-only; "auto" = managed sidecar or GAIA_RERANK_URL). */
  reranker: "auto" | "off";
  consolidate: MemoryConsolidateConfig;
  decayHalfLifeDays: number;
}

export interface MemoryConfigPatch {
  autoRecall?: boolean;
  autoRecallBudget?: number;
  embeddings?: MemoryConfig["embeddings"];
  reranker?: MemoryConfig["reranker"];
  consolidate?: Partial<MemoryConsolidateConfig>;
  decayHalfLifeDays?: number;
}

/** One observer hook: a shell command run by the daemon at a room-lifecycle
 * point. The event payload arrives as JSON on stdin (+ GAIA_HOOK_* env).
 * Fire-and-forget — a hook never blocks or fails a turn. */
export interface HookCommand {
  command: string;
  /** Kill the hook after this many seconds (default 10). */
  timeoutSec?: number;
}

/** Hooks run at the ROOM layer, so they are uniform for every harness by
 * construction — no per-harness translation, no gating (the sandbox is the
 * boundary; hooks observe). */
export interface HooksConfig {
  /** Before an agent turn is dispatched. */
  preTurn?: HookCommand[];
  /** After a reply commits (payload carries reply, outcome, tools). */
  postTurn?: HookCommand[];
  /** After each tool call inside a turn settles. */
  toolUse?: HookCommand[];
  /** A turn failed (payload carries the error). */
  error?: HookCommand[];
}

/** One MCP server, workspace- or agent-scoped. `command` (stdio) or `url`
 * (remote) — each harness translates this shape onto its own MCP surface
 * (claude --mcp-config, codex mcp_servers config); pi has no core MCP. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface SandboxConfig {
  enabled?: boolean;
  backend?: string;
  writable?: string[];
  net?: "full" | "none";
  credentialProxy?: boolean;
}

/** How concurrent rooms share the workspace repo (config `collab`).
 * - `shared` (default): every room runs at the workspace root — one working
 *   tree, one index; simultaneous agents can collide.
 * - `worktree`: each TOP-LEVEL room gets its own git worktree under
 *   `.gaia/worktrees/<roomId>` on branch `<branchPrefix><roomId>` (shared
 *   object store, isolated checkout + index), created on first open. Summon
 *   rooms never own one — they inherit the nearest ancestor room's checkout,
 *   walking up to the top-level room. The path is stamped on the room's
 *   durable state (RoomState.workDir); merging back is the humans'/agents'
 *   call — the daemon never auto-integrates.
 * Only fields that DO something live here: no speculative knobs. */
export interface CollabConfig {
  isolation: "shared" | "worktree";
  /** Branch namespace for room worktrees. Default "gaia/". */
  branchPrefix: string;
}

/** Per-agent read-aloud TTS choice (agent.json `tts`): which registered engine
 * speaks this agent's messages, and the engine-specific voice to use. */
export interface AgentTtsConfig {
  engine?: string;
  voice?: string;
}

/** Per-agent protocol switches from agent.json `protocols`. Every protocol is
 * enabled unless its filename-without-`.md` key is explicitly `false`. */
export type AgentProtocolConfig = Record<string, boolean>;

/** AgentDef.insight tiers — see the field doc on AgentDef.insight for the
 * full contract (decree 2026-07-28). */
export type InsightLevel = "none" | "line" | "full";

export interface AgentDef {
  id: string;
  displayName: string;
  icon: string;
  voice?: string;
  /** Read-aloud TTS for the transcript play button (voice calls use `voice`). */
  tts?: AgentTtsConfig;
  // Resolved locations (global agent dir + optional project overlay).
  dir: string;
  configPath: string;
  personaDir: string;
  rolesDir: string;
  defaultRole?: string; // global default role from agent.json "role"; a room's activeRoles entry overrides it ("none" = explicitly no role)
  soulPath: string;
  memoryDir: string;
  projectDir?: string;
  projectConfigPath?: string;
  projectPersonaDir?: string;
  projectRolesDir?: string;
  projectIntentPath?: string;
  // Hard control.
  tools: string[];
  /** Default true: direct tools dispatched by `gaia` are collapsed to `gaia`.
   * Set `gaiaOnly: false` in agent.json to restore the explicit legacy list. */
  gaiaOnly: boolean;
  /** Present only when agent.json explicitly sets `tools`. An unset tools key
   * inherits the active role's tool defaults (or the normal agent defaults). */
  toolOverride?: string[];
  /** Skills to load for this agent, by name — resolved against every
   * auto-detected skill dir (gaia/pi/claude/codex/hermes). Merged with the
   * active role's skills. Detected ≠ loaded: this is where you opt in. */
  skills?: string[];
  /** Present only when agent.json explicitly sets `skills`; see toolOverride. */
  skillOverride?: string[];
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  /** Per-protocol opt-outs; absent keys remain enabled. Keys are filenames
   * from the configured protocols directory without their `.md` extension. */
  protocols?: AgentProtocolConfig;
  /** Optional agent.json law line appended fresh to EVERY composed turn
   * prompt ("\n\n" + turnLaw) so it is always the newest tokens. No default
   * content lives in code — the value comes only from agent.json. */
  turnLaw?: string;
  /** Optional agent.json law line prepended as the VERY FIRST tokens of the
   * composed system prompt (before `# Agent Soul`). No default content lives
   * in code — the value comes only from agent.json. */
  promptLaw?: string;
  harness?: string;
  /** Harness permission posture, passed through verbatim. The value vocabulary
   * is each harness's own, declared as DATA on its spec (ui.permissionModes) —
   * core stays harness-blind, exactly like `harness` above. Only harnesses
   * declaring supportsPermissionMode honor it. */
  permissionMode?: string;
  /** Named provider account (a record id in ~/.gaia/accounts.json) whose
   * credentials this agent's harness subprocess runs under. Harness-blind
   * here — the wiring is data on the harness spec (HarnessSpec.accounts),
   * exactly like `harness`/`permissionMode` above. Unset = the harness's
   * ambient login. */
  account?: string;
  sandbox?: SandboxConfig;
  /** Trust tier (default true). false → forced real sandbox, may never summon. */
  trust?: boolean;
  /** May summon further workers when itself a summon (default false). */
  allowNestedSummon?: boolean;
  /** Agent-tier plugin capability grants (agent.json `capabilities`, default
   * []) — unioned with the workspace-tier grant (.gaia/config.json
   * `plugins.grants[id]`) by the capability resolver
   * (services/capabilities/resolver.ts). Trust-floored: read only when
   * `trust !== false` (services/capabilities/broker.ts) — declaring a
   * capability here never widens an untrusted agent's grant set. */
  capabilities?: string[];
  /** How much of THIS agent's summon history it gets to keep, as the caller
   * (not as the worker — a ghoul's own room is incognito regardless, see
   * services/summons.ts). Default "none": today's behavior, a summon's child
   * room leaves no trace once it delivers. "line": a distilled entry (task +
   * outcome, truncated, never the raw transcript) is appended to
   * `<memoryDir>/ledgers/<workerAgentId>.md` at each summon's lane close —
   * readable via the normal `memory` tool (file: "ledgers/<id>.md"). "full":
   * same ledger, plus this agent is the one persona meant to actually read
   * its workers' raw rooms (it already has filesystem reach via bash/read;
   * this documents that as intended, not incidental). Never widens the
   * SHARED recall index or its PII surface — a ghoul room's incognito bit
   * (domain/workspace-index.ts roomIsIncognito) is untouched by this. */
  insight?: InsightLevel;
  /** Per-agent memory overrides applied over the workspace MemoryConfig. */
  memory?: MemoryConfigPatch;
  /** Per-agent MCP servers, merged over the workspace set (agent wins). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Extra environment for the harness subprocess (agent wins over inherited
   * process.env). The cost knobs live here: e.g. CLAUDE_CODE_MAX_CONTEXT_TOKENS
   * caps the effective window so autocompact fires earlier and every turn
   * re-reads a smaller context. */
  env?: Record<string, string>;
}

