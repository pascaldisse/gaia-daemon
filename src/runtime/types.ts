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
}
