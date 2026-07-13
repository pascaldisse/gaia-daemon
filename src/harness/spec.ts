// One descriptor per harness. Adding a harness = one `harness/<x>.ts` module
// calling `registerHarness(...)` at its bottom + one import line in the barrel
// (harness/index.ts). Nothing else learns the harness id: differences live as
// DATA on the spec (capabilities, ui, credentialProxy, backgroundTasks,
// sandboxPaths), read
// uniformly — never as `=== "claude"` branches. This rule is absolute
// (AGENTS.md §RULE #0).

import { DEFAULTS } from "../core/config.js";
import type { AgentDef, AgentEvent, BackgroundTaskInfo, CompactProgressUpdate, CompactResult, MessageAttachment, RoomEvent, UsageProbeResult, Workspace } from "../core/types.js";
import { listAccounts, type AccountRecord } from "../domain/accounts.js";
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
  /** Settings ▸ General ▸ "Your name" (services/user-name.ts): the label the
   * shared transcript renderer uses for the human's own messages, in place of
   * the anonymous "user" token. "" / absent keeps that default. */
  userName?: string;
}

export interface AgentRuntime {
  readonly agent: AgentDef;
  readonly modelLabel: string;
  readonly capabilities: HarnessCapabilities;
  /** Stream one turn. Clean iterable exhaustion means the harness delivered a
   * proper completion record. Every other teardown — process exit without a
   * result, channel error, abort, or stall-abort — MUST throw after yielding
   * any queued events, so the uniform runner sends `turn-error` and the room
   * can commit the accumulated partial instead of mistaking it for success. */
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
  /** Inject guidance into the room's RUNNING turn (backs /steer). Resolves
   * false when there is nothing to steer. Only present when
   * capabilities.supportsSteer. `attachments` mirror AgentInput.attachments:
   * the shared caller always appends the uniform path breadcrumb to `message`,
   * and a harness with a mid-turn native image channel additionally inlines the
   * bytes in its own steer() (pi steer images, claude stream-json image blocks,
   * codex localImage items) — its own translation, never a shared-code branch. */
  steer?(roomId: string, message: string, attachments?: MessageAttachment[]): Promise<boolean>;
  /** Push a daemon-synthesized event (e.g. the `steered` position marker) into
   * the ACTIVE turn's event stream at its current position. Implemented ONCE by
   * the daemon-side RunnerHost — uniform for every harness, which never sees
   * it; absent on the runner-side harness runtimes. Returns false when no turn
   * is streaming (the marker is simply skipped). */
  injectEvent?(event: AgentEvent): boolean;
  /** Compact the room's session context using the HARNESS's own compaction
   * (backs /compact — gaia never re-implements summarization). Resolves with
   * `{ compacted, message }`: `compacted` is the authoritative "history was
   * evicted" signal the daemon uses to place the visible boundary (no prose
   * scraping); `message` is the human-readable line. `onProgress`, when supplied,
   * receives whatever token counts the harness can report as the pass runs
   * (best-effort). Only present when capabilities.supportsCompact. */
  compact?(roomId: string, onProgress?: (update: CompactProgressUpdate) => void): Promise<CompactResult>;
  dispose(): void | Promise<void>;
  /** Drop the room's session so the next turn starts fresh (backs /clear). */
  resetRoom(roomId: string): void;
  /** Drop the session-scoped system-prompt snapshot; the next assembly
   * re-reads soul/AGENTS.md/skills from disk. */
  refreshContext?(roomId: string): void;
  /** Does a durable, resumable session for this room still exist? An agent's
   * transcript cursor promises "everything before me lives in the harness
   * session" — when the session is gone (crash, dropped handle, pruned store)
   * that promise is broken, and the turn loop must replay the history instead
   * of silently starting the agent mid-conversation. Absent ⇒ assume it does
   * (fail-safe: never spuriously reload). */
  hasDurableSession?(roomId: string): boolean;
}

// --- capabilities + ui (data on the spec) --------------------------------------

export type GaiaTool = "memory" | "recall" | "summon" | "resume";

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
   * turn/steer, claude stream-json stdin)? Backs /steer and steer-by-default. */
  readonly supportsSteer: boolean;
  /** Has a native session-compaction the runtime can invoke (pi
   * session.compact, claude /compact, codex thread compaction)? Backs
   * /compact. */
  readonly supportsCompact: boolean;
  /** Passes an UNRECOGNIZED gaia slash command through to its underlying CLI as
   * a native command turn (claude runs it as a skill/slash-command with the
   * command surface enabled). Backs "/deep-research"-style passthrough, gated
   * per agent by CHECKING the command's name in the agent's `skills` (a fileless
   * builtin this harness advertises via nativeCommands()). Harnesses with no such
   * surface (codex, pi) declare false and never receive one. Absent on a runtime
   * double ⇒ treated as false. */
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
  /** The harness's own permission-posture vocabulary, passed verbatim to its
   * CLI; shown as the permissionMode select options. Absent ⇒ the harness has
   * no such knob (the UI hides the select). */
  permissionModes?: string[];
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

// --- named accounts (data, applied uniformly by RunnerHost) ---------------------

/** One add-account form field a harness declares; collected VERBATIM into the
 * stored record's credential bag (~/.gaia/accounts.json) — the shared layer
 * never interprets it. */
export interface AccountFieldDef {
  key: string;
  label: string;
  /** Mask in UIs / never echo back. */
  secret?: boolean;
  placeholder?: string;
  /** How the user obtains the value (rendered as help text). */
  hint?: string;
}

/** Interactive login flow for creating an account, declared as data+extractors
 * on the spec: the shared AccountLoginService allocates a pseudo-tty, runs
 * `command`, feeds ANSI-stripped output through the extractors, forwards the
 * user's paste-back input, and stores the resulting credential bag — never
 * learning what any of it means (RULE #0). */
export interface AccountLoginSpec {
  /** The interactive command. ctx.configDir is a THROWAWAY isolated dir the
   * flow must be pointed at so it can never disturb the machine's ambient
   * login (e.g. claude's keychain session). */
  command(ctx: { configDir: string }): { argv: string[]; env?: Record<string, string> };
  /** Extract the sign-in URL from the output so far, once present. */
  signInUrl(output: string): string | undefined;
  /** True while the flow is waiting for a paste-back code from the user. */
  awaitingInput(output: string): boolean;
  /** A short code the user must read and re-enter ON THE SIGN-IN PAGE itself
   * (device-authorization flows: nothing is pasted back into this process —
   * it polls the provider until the site marks the code approved). Shown
   * next to the sign-in link. Absent ⇒ no such code (e.g. a plain OAuth
   * redirect where approving the link is the whole flow). */
  code?(output: string): string | undefined;
  /** Extract the finished credential bag; configDir may hold fallback state
   * the CLI wrote (checked again after the process exits). */
  credentials(ctx: { output: string; configDir: string }): Record<string, string> | undefined;
}

/** Multi-account support, declared as DATA on the spec (same law as
 * credentialProxy): the daemon stores NAMED accounts as opaque credential bags
 * and RunnerHost merges `env(credentials)` into the subprocess env of any agent
 * bound to one (AgentDef.account) — read uniformly, so the shared layer never
 * learns which harness an account belongs to or what its fields mean. Agents
 * may only bind to accounts of their own harness (enforced at spawn, loudly).
 * Absent ⇒ this harness has no account concept: its agents always run on the
 * ambient login (keychain / config dir / env of the daemon). */
export interface HarnessAccountsSpec {
  /** UI noun for one of this harness's accounts, e.g. "Claude account". */
  label: string;
  /** The fields the add-account form collects. */
  fields: AccountFieldDef[];
  /** Env merged into a bound agent's subprocess — e.g. claude's
   * CLAUDE_CODE_OAUTH_TOKEN, which its CLI honors over the keychain login. */
  env(credentials: Record<string, string>): Record<string, string>;
  /** Best-effort identity extraction from an opaque credential bag. */
  email?(credentials: Record<string, string>): string | undefined;
  /** Interactive in-app login; absent = accounts for this harness are created
   * by pasting credentials into accounts.json directly. */
  login?: AccountLoginSpec;
}

// --- the spec + registry ----------------------------------------------------------

export interface HarnessSpec {
  id: string;
  capabilities: HarnessCapabilities;
  ui: HarnessUi;
  create(ctx: RuntimeCreateContext): AgentRuntime;
  /** Error-message signatures of a TRANSIENT auth/session reset (login expired, token revoked).
   * Matching turn errors are marked TransientAuthError by the shared layer and requeued with
   * backoff instead of failing the turn. Differences live as DATA here — never as harness-id
   * branches (RULE #0). */
  transientAuthPatterns?: RegExp[];
  /** Parse a harness-native detached process from a completed tool call. The
   * shared host invokes this descriptor uniformly after every tool-end; absent
   * means this harness does not expose background-process starts. */
  backgroundTasks?: {
    fromToolCall(toolName: string, args: unknown, result: unknown): BackgroundTaskInfo | undefined;
  };
  credentialProxy?(ctx: CredentialProxyContext): CredentialProxyWiring;
  /** Named multi-account wiring (see HarnessAccountsSpec). Absent ⇒ this
   * harness has no account concept. */
  accounts?: HarnessAccountsSpec;
  /** Home-dir carves this harness's CLI needs inside the sandbox, declared as
   * DATA on the spec (same pattern as credentialProxy): `writable` is the
   * regenerable state the CLI must write to stay alive/resumable (session +
   * model caches — a turn wedges or forgets its session when denied);
   * `readonly` is carved back out of those writable trees (the credential
   * store, so a confined turn can't tamper with the keys it can read). A
   * leading `~` expands to the user's home dir. RunnerHost threads these into
   * the sandbox launch uniformly — the backend never learns which harness
   * declared them. Absent ⇒ no extra carves. */
  sandboxPaths?: { writable?: string[]; readonly?: string[] };
  /** A-priori context window (tokens) for one of this harness's models, used by
   * the context-gate warning BEFORE a turn runs (the harness only reports the
   * real window mid-turn). Data on the spec, read uniformly — never id-branched.
   * Undefined when the harness can't say, so the UI shows tokens without a %. */
  contextWindow?(model: string | undefined): number | undefined;
  /** Resolve one of this harness's own model names/aliases (e.g. claude's
   * "fable"/"opus"/"sonnet"/"haiku", passed verbatim to its CLI) to a real
   * pi-ai model registry id. Needed ONLY by callers that talk to a model
   * DIRECTLY through pi-ai instead of through this harness's own subprocess
   * (e.g. the daemon-side consolidation/dream LLM, which reuses an agent's
   * configured model but bypasses its harness entirely) — every such caller
   * must resolve through here uniformly rather than assuming the name is
   * already a registry id. Data on the spec, read uniformly — never
   * id-branched. Absent ⇒ the harness's model names ARE registry ids already
   * (pass through unchanged). */
  resolveApiModelId?(name: string): string;
  /** Native passthrough commands this harness advertises for `/`-autocomplete
   * (claude: its builtins + discoverable skills). Data on the spec, read
   * uniformly: surfaced as pickable Skills options, and a checked FILELESS one
   * (no on-disk SKILL.md) is what routes as native passthrough. A name absent
   * here can't be enabled, so keep the list current. Absent ⇒ none advertised. */
  nativeCommands?(): NativeCommandDef[];
  /** Does a durable session handle for (room, agent) survive on disk? Answered
   * from the harness's own persistence (claude/codex harness-sessions.json, pi
   * session files) WITHOUT spawning anything — a fresh daemon process is
   * exactly the case that matters. Read uniformly by RunnerHost.hasDurableSession
   * before a turn: false with a deep cursor ⇒ the conversation behind the
   * cursor is gone and must be replayed (through the context gate when large).
   * Absent ⇒ sessions are not detectable a-priori; treated as present. */
  hasDurableSession?(rootDir: string, roomId: string, agentId: string): boolean;
  /** The SUBSCRIPTION ACCOUNTS this harness can read usage for, each with a
   * probe that fetches that account's limits (session / weekly caps). Data on
   * the spec — the harness owns WHICH accounts its credential store covers and
   * HOW it reaches the provider's usage endpoint; the daemon groups candidates
   * by account id uniformly and never learns which harness supplied one (same
   * pattern as credentialProxy). Several harnesses may declare the SAME account
   * (claude and pi both hold Anthropic OAuth): the daemon probes candidates in
   * registration order until one returns `ok`, so a broken credential source
   * never blanks a meter another source can still feed — and one account is
   * never double-fetched against a rate-limited endpoint. Each probe returns a
   * discriminated {@link UsageProbeResult}: `ok` with the limits, `none` when
   * there is authoritatively nothing to show (no OAuth creds, API-key auth),
   * or `error` for a TRANSIENT failure (rate-limited, offline, locked
   * keychain, token mid-rotation) that must NOT blank a healthy meter. Absent
   * ⇒ reports no account usage. Account-level, so probes take no room/agent —
   * one call describes the whole subscription. */
  usageAccounts?(accounts: readonly AccountRecord[]): UsageAccountProbe[];
  /** Usage key for an agent using this harness's ambient login. Named accounts
   * use AgentDef.account directly; this is only needed where an ambient store
   * can hold more than one provider identity. */
  ambientUsageAccount?(agent: AgentDef): string | undefined;
}

/** One (account, probe) candidate a harness declares (see usageAccounts). */
export interface UsageAccountProbe {
  /** Subscription account id, e.g. "anthropic" | "openai". */
  account: string;
  probe(): Promise<UsageProbeResult>;
}

/** Every registered harness's usage candidates, grouped by account id in
 * registration order — read uniformly by the daemon's poll loop. No harness-id
 * branch — each harness declares its accounts as data on its spec. */
export function usageAccountProbes(): Map<string, Array<() => Promise<UsageProbeResult>>> {
  const byAccount = new Map<string, Array<() => Promise<UsageProbeResult>>>();
  const accounts = listAccounts();
  for (const spec of harnessSpecs()) {
    const owned = accounts.filter((account) => account.harness === spec.id);
    for (const candidate of spec.usageAccounts?.(owned) ?? []) {
      const list = byAccount.get(candidate.account) ?? [];
      list.push(candidate.probe);
      byAccount.set(candidate.account, list);
    }
  }
  return byAccount;
}

/** The exact persisted usage key an agent can spend from. This is a uniform
 * account-resolution boundary: room snapshots never infer an account from a
 * model/provider label. */
export function usageAccountFor(agent: AgentDef, workspace: Workspace): string | undefined {
  if (agent.account) return agent.account;
  return findHarness(harnessIdFor(agent, workspace))?.ambientUsageAccount?.(agent);
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
  const spec = registry.get(id) ?? registry.get(DEFAULTS.harness);
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
  return agent.harness ?? workspace.config.harness ?? DEFAULTS.harness;
}
