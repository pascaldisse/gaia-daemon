// Wire protocol between the daemon-side RunnerHost and the agent-runner
// subprocess. One newline-delimited JSON object per line, both directions.
//
// The runner is single-flight: the controller runs one turn per room at a time,
// so there is at most one active turn per runner and messages need no turn id.

import type { AgentEvent, AgentInput } from "./types.js";

/** Daemon -> runner. */
export type RunnerCommand =
  | { type: "turn"; input: AgentInput }
  | { type: "abort" }
  | { type: "reset"; roomId: string }
  | { type: "dispose" };

/** Runner -> daemon. */
export type RunnerMessage =
  | { type: "ready"; modelLabel: string }
  | { type: "event"; event: AgentEvent }
  /** The model label the runtime resolved (sent when it changes). */
  | { type: "model-label"; modelLabel: string }
  | { type: "turn-end" }
  | { type: "turn-error"; message: string };

/** Env keys the daemon sets when spawning a runner (read by agent-runner). */
export const RUNNER_ENV = {
  workspacePath: "GAIA_RUNNER_WORKSPACE",
  agentId: "GAIA_RUNNER_AGENT",
  harness: "GAIA_RUNNER_HARNESS",
  roomId: "GAIA_ROOM_ID",
  // Bridge env (shared shape with the `gaia` CLI harness): daemon url + token +
  // memory/room dirs. Present only when a daemon bridge exists.
  daemonUrl: "GAIA_DAEMON_URL",
  daemonToken: "GAIA_DAEMON_TOKEN",
  memoryDir: "GAIA_MEMORY_DIR",
  roomDir: "GAIA_ROOM_DIR",
} as const;
