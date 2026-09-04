// Pi session contracts and durable-session helpers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDef, ThinkingLevel, Workspace } from "../../core/types.js";
import { workspacePaths } from "../../core/paths.js";
import type { RuntimeCreateContext } from "../spec.js";
// ---------------------------------------------------------------------------

export interface PiRuntimeOptions extends RuntimeCreateContext {
  sessionFactory?: PiRuntimeSessionFactory;
  /** Alternate explicit clean-summary registry for isolated tests. Production
   * omits this and reads ~/.pi/agent/clean-summaries/index.json. */
  cleanCompactionIndexPath?: string;
}

export interface PiSessionLike {
  readonly model?: { provider: string; id: string } | undefined;
  readonly thinkingLevel?: string;
  setThinkingLevel?(level: string): void;
  subscribe(listener: (event: any) => void): () => void;
  prompt(
    text: string,
    options?: {
      source?: "interactive";
      images?: { type: "image"; data: string; mimeType: string }[];
    },
  ): Promise<void>;
  /** Queue a steering message into the running prompt (pi SDK). Pasted images
   * ride the SDK's mid-turn image channel, the same shape prompt() takes. */
  steer?(
    text: string,
    images?: { type: "image"; data: string; mimeType: string }[],
  ): Promise<void>;
  /** Window-relative context accounting (pi SDK getContextUsage). `tokens`
   * is null right after a compaction, until the next assistant reply. */
  getContextUsage?():
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  /** Native session compaction — the same call the pi CLI's /compact runs. */
  compact?(
    customInstructions?: string,
  ): Promise<{
    summary: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
  }>;
  /** Every user-message entry in this session, IN ORDER (id + text) — pi's own
   * addressing for forking (dist/core/agent-session.js). forkAtMessage maps
   * gaia's origin to pi's entry purely by POSITION: the Kth of these is the
   * Kth thing the human said (see there — text is never matched). Already
   * present at runtime on the real AgentSession; declared here so the typed
   * cast can call it. */
  getUserMessagesForForking?(): Array<{ entryId: string; text: string }>;
  /** Pi's native in-session fork: rewind the tree to `targetEntryId` — the new
   * leaf becomes that entry's parent, so the target user message and everything
   * after it leave the LIVE model context (agent.state.messages is resynced
   * immediately). A new tree branch in the SAME file; the abandoned branch is
   * preserved on disk. The follow-up re-send (edit/retry always re-prompts)
   * appends under the new leaf and persists it, so the fork survives a restart
   * (continueRecent seeds the leaf from the file's last entry = the new tip).
   * Already present at runtime on the real AgentSession. */
  navigateTree?(
    targetEntryId: string,
  ): Promise<{ cancelled: boolean; editorText?: string }>;
  /** The session's own SessionManager — a public field on the real
   * AgentSession (dist/core/agent-session.js). This is the minimal slice
   * forkAtMessage needs to branch the persisted session using the SAME
   * primitives pi's own `AgentSessionRuntime.fork()` composes them from
   * (dist/core/agent-session-runtime.js) — gaia holds a bare AgentSession,
   * never that wrapper, so it re-composes the primitives itself rather than
   * calling a single pre-built fork() method. Already present at runtime;
   * declared here so the typed cast can reach it. */
  readonly sessionManager?: {
    getEntry(id: string): { parentId: string | null | undefined } | undefined;
    getSessionFile(): string | undefined;
    /** Rewrite THIS manager's own on-disk file to hold only root→targetLeafId
     * (drops targetLeafId's siblings/descendants), returning the new file
     * path — or undefined when the session isn't persisted. Mutates the
     * manager in place (dist/core/session-manager.js). */
    createBranchedSession(targetLeafId: string): string | undefined;
    /** Start a brand-new empty session, recording `parentSession` as its
     * lineage — pi's own fallback when forking "before" the very first
     * message (no parent entry to branch to). Mutates the manager in place. */
    newSession(options?: { parentSession?: string }): string | undefined;
  };
  /** The session's own read-only SettingsManager (the instance gaia passes to
   * createAgentSession). compact() reaches it to force a smaller recent-keep
   * window when an explicit /compact would otherwise no-op as "session too
   * small". applyOverrides only mutates the in-memory merged settings — it never
   * writes to disk — so it is safe on the read-only manager. Already present at
   * runtime; declared here so the typed cast can reach it. */
  readonly settingsManager?: {
    getCompactionKeepRecentTokens(): number;
    applyOverrides(overrides: {
      compaction?: { keepRecentTokens?: number };
    }): void;
  };
  abort(): Promise<void>;
  reload(): Promise<void>;
  dispose(): void;
}

export interface PiRuntimeSessionFactoryOptions {
  cwd: string;
  roomId: string;
  agent: AgentDef;
  loader: DefaultResourceLoader;
  systemPromptRef: { current: string };
  skillPaths: string[];
  /** Allowlist passed to Pi; includes custom tool names (memory, recall). */
  tools: string[];
  customTools: unknown[];
  model: Model<any> | undefined;
  sessionDir: string;
}

export type PiRuntimeSessionFactory = (
  options: PiRuntimeSessionFactoryOptions,
) => Promise<{ session: PiSessionLike; modelFallbackMessage?: string }>;

/** Per-room session metadata tracked by the uniform SessionMap. */
export interface PiSessionMeta {
  session: PiSessionLike;
  loader: DefaultResourceLoader;
  systemPromptRef: { current: string };
  skillPathsKey: string;
  // Thinking level the session was created with; turns without an explicit
  // override restore it (voice mode may have switched it off).
  baseThinking?: string;
}

export function piRoomSessionDir(
  workspace: Pick<Workspace, "rootDir">,
  roomId: string,
  agentId: string,
): string {
  return join(workspacePaths.piSessionsDir(workspace.rootDir, roomId), agentId);
}

// Any file under the room/agent's session dir means SessionManager.continueRecent
// has something to resume; an empty or missing dir means there is genuinely no
// session (fresh room or a room that never sent this agent a turn). Shared by
// the harness spec's hasDurableSession (host.ts's pre-spawn gate) and compact()'s
// own lazy-restore decision below — one on-disk truth, read twice.
/** Forced recent-keep window (tokens) for an EXPLICIT /compact that would
 * otherwise no-op because the whole session sits under pi's default 20000
 * keepRecentTokens floor (findCutPoint then finds nothing outside the kept
 * window). A user who runs /compact wants the session shrunk NOW, so the retry
 * keeps only a small live tail and summarizes the rest. Restored immediately. */
const FORCE_COMPACT_KEEP_RECENT_TOKENS = 2000;

export function hasPersistedPiSession(
  rootDir: string,
  roomId: string,
  agentId: string,
): boolean {
  try {
    return (
      readdirSync(piRoomSessionDir({ rootDir }, roomId, agentId)).length > 0
    );
  } catch {
    return false; // no dir ⇒ nothing to resume
  }
}

// Pi sessions persist "last used" model and thinking level back into the
// user's pi settings (~/.pi/agent/settings.json). GAIA controls both per
// agent.json - and voice calls toggle thinking every call - so its sessions
// must read the user's pi defaults without ever rewriting them. Reads pass
// through to the real files; writes are dropped.
export function readOnlyPiSettings(cwd: string): SettingsManager {
  const paths = {
    global: join(getAgentDir(), "settings.json"),
    project: join(cwd, ".pi", "settings.json"),
  };
  return SettingsManager.fromStorage({
    withLock(
      scope: "global" | "project",
      fn: (current: string | undefined) => string | undefined,
    ): void {
      const path = paths[scope];
      fn(existsSync(path) ? readFileSync(path, "utf8") : undefined);
    },
  });
}
export function skillPathsKey(paths: string[]): string {
  return JSON.stringify(paths);
}
// GAIA's ThinkingLevel adds "max" on top of pi's own ceiling (pi-agent-core's
// ThinkingLevel tops at "xhigh" — Claude CLI is the only harness that has a
// literal "max" effort). Clamp at the pi SDK boundary so a session never gets
// handed a level pi doesn't know: an unmapped string falls back to pi-ai's
// internal default ("high") inside mapThinkingLevelToEffort, which is WORSE
// than xhigh, not a safe no-op. Used both for session creation (thinkingLevel)
// and the hot per-turn override (setThinkingLevel) so pi always receives the
// same clamped vocabulary either way.
export function toPiThinking(level: ThinkingLevel | string | undefined): any {
  return level === "max" ? "xhigh" : level;
}
