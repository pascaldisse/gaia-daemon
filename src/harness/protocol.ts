// Wire protocol between the daemon-side RunnerHost and the `gaia __run-agent`
// subprocess. One newline-delimited JSON object per line, both directions.
// The runner is single-flight: at most one active turn per runner.

import type { AgentEvent } from "../core/types.js";
import type { AgentInput } from "./spec.js";

/** Daemon -> runner. */
export type RunnerCommand =
  | { type: "turn"; input: AgentInput }
  | { type: "abort" }
  | { type: "steer"; roomId: string; message: string }
  | { type: "reset"; roomId: string }
  | { type: "dispose" };

/** Runner -> daemon. */
export type RunnerMessage =
  | { type: "ready"; modelLabel: string }
  | { type: "event"; event: AgentEvent }
  | { type: "model-label"; modelLabel: string }
  | { type: "turn-end" }
  | { type: "turn-error"; message: string }
  | { type: "steer-result"; ok: boolean };

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
  /** Set ONLY when the credential proxy is enabled for this turn. */
  llmProxyUrl: "GAIA_LLM_PROXY_URL",
} as const;

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
    default:
      return undefined;
  }
}
