import type { AgentDefinition } from "../agents/types.js";
import type { RoomEvent } from "../room/transcript.js";

export interface AgentInput {
  roomId: string;
  message: string;
  transcript: RoomEvent[];
}

export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-start"; toolName: string }
  | { type: "tool-end"; toolName: string; isError: boolean };

export interface AgentRuntime {
  readonly agent: AgentDefinition;
  readonly modelLabel: string;
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  dispose(): void;
}
