// Runs one agent turn over a runtime's event stream, accumulating the reply
// text and the runtime details (model, thinking, tools) that commit ONTO the
// transcript event. The caller owns durability (WAL) and UI transport.

import type { AgentEvent, EventDetails, ToolDetail } from "../core/types.js";
import type { AgentInput, AgentRuntime } from "../harness/spec.js";

export interface AgentTurnOptions {
  runtime: AgentRuntime;
  input: AgentInput;
  isCancelled?: () => boolean;
  onEvent?: (event: AgentEvent) => void;
  /** Fires after each text-delta with the full running reply so the caller can
   * durably persist partial progress (throttling is the caller's). Awaited so
   * persistence stays ordered with the stream. */
  onProgress?: (reply: string) => void | Promise<void>;
}

export interface AgentTurnResult {
  reply: string;
  details: EventDetails;
  cancelled: boolean;
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const isCancelled = options.isCancelled ?? (() => false);
  const details: EventDetails = {};
  let reply = "";

  for await (const event of options.runtime.send(options.input)) {
    if (isCancelled()) return { reply, details, cancelled: true };
    if (event.type === "text-delta") reply += event.delta;
    applyEventToDetails(details, event);
    options.onEvent?.(event);
    if (event.type === "text-delta" && options.onProgress) await options.onProgress(reply);
  }

  return { reply, details, cancelled: isCancelled() };
}

export function applyEventToDetails(details: EventDetails, event: AgentEvent): void {
  switch (event.type) {
    case "model-info":
      details.model = `${event.provider}/${event.modelId}${event.subscription ? " (oauth)" : ""}`;
      return;
    case "thinking-start":
      details.thinkingStarted = true;
      return;
    case "thinking-delta":
      details.thinkingStarted = true;
      details.thinking = `${details.thinking ?? ""}${event.delta}`;
      return;
    case "thinking-end":
      details.thinkingStarted = true;
      if (event.content && !details.thinking) details.thinking = event.content;
      return;
    case "tool-start":
      details.tools = [...(details.tools ?? []), newToolDetail(event.toolCallId, event.toolName, "running", { args: event.args })];
      return;
    case "tool-update": {
      const tool = findRunningTool(details, event.toolCallId, event.toolName);
      if (tool) tool.partialResult = event.partialResult;
      return;
    }
    case "tool-end": {
      const tool = findRunningTool(details, event.toolCallId, event.toolName);
      if (tool) {
        tool.status = event.isError ? "error" : "complete";
        tool.result = event.result;
      } else {
        details.tools = [
          ...(details.tools ?? []),
          newToolDetail(event.toolCallId, event.toolName, event.isError ? "error" : "complete", { result: event.result }),
        ];
      }
      return;
    }
    default:
      return;
  }
}

function newToolDetail(
  toolCallId: string | undefined,
  toolName: string,
  status: ToolDetail["status"],
  values: Pick<ToolDetail, "args" | "partialResult" | "result">,
): ToolDetail {
  return {
    id: toolCallId ?? `${toolName}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    toolName,
    status,
    ...(values.args !== undefined ? { args: values.args } : {}),
    ...(values.partialResult !== undefined ? { partialResult: values.partialResult } : {}),
    ...(values.result !== undefined ? { result: values.result } : {}),
  };
}

function findRunningTool(details: EventDetails, toolCallId: string | undefined, toolName: string): ToolDetail | undefined {
  const tools = details.tools ?? [];
  if (toolCallId) return tools.find((tool) => tool.id === toolCallId);
  return [...tools].reverse().find((tool) => tool.toolName === toolName && tool.status === "running");
}
