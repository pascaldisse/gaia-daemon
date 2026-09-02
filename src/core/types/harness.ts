import type { SkillInvocation } from "./events.js";

// ---------------------------------------------------------------------------
// Harness stream events (what a runtime yields during a turn)

export interface BackgroundTaskInfo {
  taskId: string;
  command?: string;
  description?: string;
  outputPath?: string;
}

export interface BackgroundTask extends BackgroundTaskInfo {
  toolName: string;
  startedAt: string;
  agentId: string;
  /** The room this process was launched from. Snapshots today only carry the
   * viewing room's own tasks, but the tray labels and jumps by this id
   * regardless — the one durable place a background task remembers its
   * origin, ready the moment a future snapshot ever merges other rooms' in. */
  roomId: string;
}

export type AgentEvent =
  | { type: "model-info"; provider: string; modelId: string; subscription: boolean }
  | { type: "model-fallback"; fromModel: string; toModel: string; reason: string }
  | { type: "context-usage"; usedTokens: number; maxTokens?: number }
  | { type: "text-delta"; delta: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end"; content?: string }
  /** Pi emitted an expanded `/skill:name` user message for this turn. */
  | { type: "skill-invocation"; skill: SkillInvocation }
  | { type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean }
  | { type: "background-task"; taskId: string; toolName: string; command?: string; description?: string; outputPath?: string }
  /** Synthesized DAEMON-side (RunnerHost.injectEvent) the moment a mid-turn
   * steer is accepted, so the marker lands in the stream — and therefore in
   * `details.blocks` — at the exact position the steer took effect. Uniform for
   * every harness by construction; no harness ever emits it. `eventId` is the
   * steer's user RoomEvent. */
  | { type: "steered"; eventId: string }
  /** Structured surfacing of an out-of-band condition worth telling the
   * consumer about without treating it as reply text — e.g. an upstream
   * stall the claude thinking-proxy detected. Never rendered as reply text. */
  | { type: "notice"; kind: "upstream-stall"; text: string };

