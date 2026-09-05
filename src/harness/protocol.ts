// Wire protocol between the daemon-side RunnerHost and the `gaia __run-agent`
// subprocess. One newline-delimited JSON object per line, both directions.
// The runner is single-flight: at most one active turn per runner.

import type { AgentEvent, CompactProgressUpdate, MessageAttachment, UiPromptReplyValue } from "../core/types.js";
import type { AgentInput } from "./spec.js";

/** Service implementations injected into harness tools at runtime. Harnesses
 * depend on this contract only; service imports stay at composition level. */
/** JSON-safe payload exchanged by the uniform runner contribution port. Runtime
 * service contracts validate plugin output again before exposing it to Gaia. */
export type PluginContributionWireValue =
  | null
  | boolean
  | number
  | string
  | readonly PluginContributionWireValue[]
  | { readonly [key: string]: PluginContributionWireValue };
export type RunnerPluginContributionKind = "command" | "tool" | "channel-bridge" | "provider";
export interface RunnerPluginContributionRequest {
  readonly requestId: string;
  readonly pluginId: string;
  readonly kind: RunnerPluginContributionKind;
  readonly name: string;
  readonly context: { readonly roomId: string; readonly agentId: string };
  readonly payload: PluginContributionWireValue;
}
export type RunnerPluginContributionResult =
  | { readonly type: "plugin-contribution-result"; readonly requestId: string; readonly ok: true; readonly payload: PluginContributionWireValue }
  | { readonly type: "plugin-contribution-result"; readonly requestId: string; readonly ok: false; readonly message: string };

export interface ToolProviders {
  artifacts: {
    list(location: { rootDir: string; roomId: string }): Promise<unknown>;
    read(location: { rootDir: string; roomId: string }, artifactId: string): Promise<{ manifest: unknown; payload: string }>;
    create(location: { rootDir: string; roomId: string }, input: { name: string; kind: "html" | "json" | "design"; mediaType: string; payload: string }): Promise<unknown>;
    update(location: { rootDir: string; roomId: string }, artifactId: string, input: { name?: string; kind?: "html" | "json" | "design"; mediaType?: string; payload?: string }): Promise<unknown>;
  };
  web: {
    search(request: { query: string; maxResults?: number; provider?: "brave" | "tavily" | "serper" }): Promise<{ provider: string; results: Array<{ title: string; url: string; snippet: string }> }>;
    fetch(request: { url: string; maxBytes?: number; transcript?: boolean; lang?: string; comments?: boolean | number }): Promise<{ url: string; title: string; text: string; video?: { provider: string; videoId: string; lang: string; channel?: string; description?: string; transcript: string; entries: number; truncated: boolean; comments?: Array<{ author: string; likes?: number; text: string }>; commentsUnavailable?: string } }>;
  };
  caryll: {
    compress(text: string): Promise<{ output: string; stats: { tokensBefore: number; tokensAfter: number; ratio: number; legendEntries: number } }>;
    expand(text: string): Promise<string>;
  };
}

/** Daemon -> runner. */
export type RunnerCommand =
  | { type: "turn"; input: AgentInput }
  | { type: "abort" }
  | { type: "steer"; roomId: string; message: string; attachments?: MessageAttachment[] }
  | { type: "ui-reply"; roomId: string; id: string; value: UiPromptReplyValue }
  | { type: "ui-shortcut-fire"; roomId: string; commandId: string }
  | { type: "compact"; roomId: string }
  | { type: "compact-clean"; roomId: string }
  | { type: "compact-draft"; roomId: string }
  | { type: "compact-apply"; roomId: string; editedSummary: string }
  | { type: "fork"; roomId: string; originEventId: string; userOrdinal: number }
  | { type: "reset"; roomId: string }
  | { type: "refresh"; roomId: string }
  /** Manifest runner contribution dispatch. Every harness shares this frame. */
  | ({ type: "plugin-contribution" } & RunnerPluginContributionRequest)
  | { type: "dispose" };

/** Runner -> daemon. */
export type RunnerMessage =
  | { type: "ready"; modelLabel: string }
  | { type: "event"; event: AgentEvent }
  | { type: "model-label"; modelLabel: string }
  // Exactly one of these terminates every turn. `turn-end` means the runtime's
  // iterable exhausted after a proper harness completion record; every
  // abnormal teardown is `turn-error`, even an underlying process exit 0.
  | { type: "turn-end" }
  | { type: "turn-error"; message: string }
  | { type: "steer-result"; ok: boolean }
  | { type: "ui-reply-result"; id: string; ok: boolean }
  | { type: "ui-shortcut-result"; commandId: string; ok: boolean }
  | ({ type: "compact-progress" } & CompactProgressUpdate)
  // `ok` = the pass ran without error; `compacted` = history was actually
  // evicted into a summary (false for a no-op). The daemon draws the visible
  // boundary from `compacted`, never from the message text.
  | { type: "compact-result"; ok: boolean; compacted: boolean; message: string; summary?: string }
  // Result of a `fork` command — see AgentRuntime.forkAtMessage.
  | { type: "fork-result"; ok: boolean; message: string }
  | RunnerPluginContributionResult;

/** Serialize one protocol frame for the newline-delimited wire.
 *
 * JSON.stringify leaves U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
 * SEPARATOR) RAW inside strings, and node's readline treats them as line
 * breaks — so a frame carrying user content with one of them (pasted rich
 * text has them constantly) reaches the peer split into fragments, every
 * fragment fails JSON.parse, and the frame silently vanishes: the turn never
 * starts and the daemon waits on it forever. Escaping them is value-identical
 * after parse and keeps every frame exactly one line regardless of content.
 * BOTH directions must use this — a reply containing U+2028 would poison
 * runner→daemon the same way. */
export function encodeFrame(frame: RunnerCommand | RunnerMessage): string {
  return JSON.stringify(frame).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The mount the in-daemon LLM credential proxy is served under. Part of the
 * daemon↔subprocess wire contract: a redirected harness's base URL is exactly
 * this path on the daemon, presented with the per-turn token. */
export const LLM_PROXY_MOUNT = "/api/harness/llm";

/** Env keys the daemon sets when spawning a runner (read by the runner). */
export const RUNNER_ENV = {
  workspacePath: "GAIA_RUNNER_WORKSPACE",
  agentId: "GAIA_RUNNER_AGENT",
  harness: "GAIA_RUNNER_HARNESS",
  roomId: "GAIA_ROOM_ID",
  daemonUrl: "GAIA_DAEMON_URL",
  daemonToken: "GAIA_DAEMON_TOKEN",
  memoryDir: "GAIA_MEMORY_DIR",
  roomDir: "GAIA_ROOM_DIR",
  /** The agent's PUBLIC id for the gaia-CLI bridge (read by `gaia mem`/`recall`
   * inside a turn — see services/cli-tools.ts). Part of the uniform bridge env
   * every harness subprocess inherits; distinct from the runner-internal
   * selector `agentId` above. */
  agentIdPublic: "GAIA_AGENT_ID",
  /** Set to "1" ONLY when the room is incognito: the runner strips the memory +
   * recall tools from the loaded agent before building the harness runtime, so
   * the strip applies uniformly to every harness (the agent is re-loaded from
   * disk in the subprocess, so a daemon-side strip alone would never reach it). */
  incognito: "GAIA_RUNNER_INCOGNITO",
  /** Set ONLY when the credential proxy is enabled for this turn. */
  llmProxyUrl: "GAIA_LLM_PROXY_URL",
} as const;

function isPluginContributionWireValue(value: unknown, seen = new Set<object>()): value is PluginContributionWireValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((item) => isPluginContributionWireValue(item, seen));
    seen.delete(value);
    return valid;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isPluginContributionWireValue(item, seen));
  seen.delete(value);
  return valid;
}

export function parseRunnerMessage(raw: unknown): RunnerMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
    case "model-label":
      return typeof msg.modelLabel === "string" ? ({ type: msg.type, modelLabel: msg.modelLabel } as RunnerMessage) : undefined;
    case "event":
      return msg.event && typeof msg.event === "object" ? ({ type: "event", event: msg.event as AgentEvent } as RunnerMessage) : undefined;
    case "turn-end":
      return { type: "turn-end" };
    case "turn-error":
      return { type: "turn-error", message: typeof msg.message === "string" ? msg.message : "turn failed" };
    case "steer-result":
      return { type: "steer-result", ok: msg.ok === true };
    case "ui-reply-result":
      return typeof msg.id === "string" ? { type: "ui-reply-result", id: msg.id, ok: msg.ok === true } : undefined;
    case "ui-shortcut-result":
      return typeof msg.commandId === "string" ? { type: "ui-shortcut-result", commandId: msg.commandId, ok: msg.ok === true } : undefined;
    case "compact-progress":
      return {
        type: "compact-progress",
        ...(typeof msg.contextTokens === "number" ? { contextTokens: msg.contextTokens } : {}),
        ...(typeof msg.outputTokens === "number" ? { outputTokens: msg.outputTokens } : {}),
      };
    case "compact-result":
      return {
        type: "compact-result",
        ok: msg.ok === true,
        compacted: msg.compacted === true,
        message: typeof msg.message === "string" ? msg.message : "",
        ...(typeof msg.summary === "string" ? { summary: msg.summary } : {}),
      };
    case "fork-result":
      return { type: "fork-result", ok: msg.ok === true, message: typeof msg.message === "string" ? msg.message : "" };
    case "plugin-contribution-result":
      if (typeof msg.requestId !== "string") return undefined;
      if (msg.ok === true) {
        return isPluginContributionWireValue(msg.payload)
          ? { type: "plugin-contribution-result", requestId: msg.requestId, ok: true, payload: msg.payload }
          : undefined;
      }
      return msg.ok === false && typeof msg.message === "string"
        ? { type: "plugin-contribution-result", requestId: msg.requestId, ok: false, message: msg.message }
        : undefined;
    default:
      return undefined;
  }
}
