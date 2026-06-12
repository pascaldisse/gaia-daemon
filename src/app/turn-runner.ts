import type { RuntimeMessageDetails, RuntimeToolDetails } from "../room/state.js";
import type { AgentEvent, AgentInput, AgentRuntime } from "../runtime/types.js";

export interface AgentTurnOptions {
  runtime: AgentRuntime;
  input: AgentInput;
  isCancelled?: () => boolean;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentTurnResult {
  reply: string;
  details: RuntimeMessageDetails;
  cancelled: boolean;
}

/**
 * Runs one agent turn over the runtime's event stream and accumulates the
 * reply text plus thinking/tool details. UI surfaces (web controller, voice
 * shim) observe raw events through onEvent and decide their own transport.
 */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const isCancelled = options.isCancelled ?? (() => false);
  const details: RuntimeMessageDetails = {};
  let reply = "";

  for await (const event of options.runtime.send(options.input)) {
    if (isCancelled()) return { reply, details, cancelled: true };
    if (event.type === "text-delta") reply += event.delta;
    applyEventToDetails(details, event);
    options.onEvent?.(event);
  }

  return { reply, details, cancelled: isCancelled() };
}

function applyEventToDetails(details: RuntimeMessageDetails, event: AgentEvent): void {
  if (event.type === "model-info") {
    details.model = `${event.provider}/${event.modelId}${event.subscription ? " (oauth)" : ""}`;
    return;
  }
  if (event.type === "thinking-start") {
    details.thinkingStarted = true;
    return;
  }
  if (event.type === "thinking-delta") {
    details.thinkingStarted = true;
    details.thinking = `${details.thinking ?? ""}${event.delta}`;
    return;
  }
  if (event.type === "thinking-end") {
    details.thinkingStarted = true;
    if (event.content && !details.thinking) details.thinking = event.content;
    return;
  }
  if (event.type === "tool-start") {
    details.tools = [...(details.tools ?? []), newToolDetails(event.toolCallId, event.toolName, "running", { args: event.args })];
    return;
  }
  if (event.type === "tool-update") {
    const tool = findRunningTool(details, event.toolCallId, event.toolName);
    if (tool) tool.partialResult = event.partialResult;
    return;
  }
  if (event.type === "tool-end") {
    const tool = findRunningTool(details, event.toolCallId, event.toolName);
    if (tool) {
      tool.status = event.isError ? "error" : "complete";
      tool.result = event.result;
    } else {
      details.tools = [
        ...(details.tools ?? []),
        newToolDetails(event.toolCallId, event.toolName, event.isError ? "error" : "complete", { result: event.result }),
      ];
    }
  }
}

function newToolDetails(
  toolCallId: string | undefined,
  toolName: string,
  status: RuntimeToolDetails["status"],
  values: Pick<RuntimeToolDetails, "args" | "partialResult" | "result">,
): RuntimeToolDetails {
  return {
    id: toolCallId ?? `${toolName}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    toolName,
    status,
    ...(values.args !== undefined ? { args: values.args } : {}),
    ...(values.partialResult !== undefined ? { partialResult: values.partialResult } : {}),
    ...(values.result !== undefined ? { result: values.result } : {}),
  };
}

function findRunningTool(details: RuntimeMessageDetails, toolCallId: string | undefined, toolName: string): RuntimeToolDetails | undefined {
  const tools = details.tools ?? [];
  if (toolCallId) return tools.find((tool) => tool.id === toolCallId);
  return [...tools].reverse().find((tool) => tool.toolName === toolName && tool.status === "running");
}
