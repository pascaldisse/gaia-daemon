import type { AgentDefinition } from "../agents/types.js";
import type { RoomEvent } from "../room/transcript.js";
import type { ResolvedRole } from "../roles/roles.js";

export interface AgentInput {
  roomId: string;
  message: string;
  transcript: RoomEvent[];
  activeRole?: ResolvedRole;
  // "voice" turns come from a live call: the reply is spoken aloud by TTS.
  channel?: "text" | "voice";
  // Per-turn thinking level override (e.g. voice mode forcing it off). When
  // absent, the runtime restores the agent's configured level.
  thinking?: string;
}

export type AgentEvent =
  | { type: "model-info"; provider: string; modelId: string; subscription: boolean }
  | { type: "text-delta"; delta: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end"; content?: string }
  | { type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean };

export interface AgentRuntime {
  readonly agent: AgentDefinition;
  readonly modelLabel: string;
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
  dispose(): void;
  /**
   * Drop the in-memory session for a single room so the next turn starts fresh
   * (backs `/clear`). Optional: a runtime with no per-room session can omit it.
   */
  clearRoom?(roomId: string): void;
}
