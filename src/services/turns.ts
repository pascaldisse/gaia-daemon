// Runs one agent turn over a runtime's event stream, accumulating the reply
// text and the runtime details (model, thinking, tools) that commit ONTO the
// transcript event. The caller owns durability (WAL) and UI transport.

import type { AgentEvent, EventDetails, MessageBlock, ToolDetail } from "../core/types.js";
import type { AgentInput, AgentRuntime } from "../harness/spec.js";

export interface AgentTurnOptions {
  runtime: AgentRuntime;
  input: AgentInput;
  isCancelled?: () => boolean;
  onEvent?: (event: AgentEvent) => void;
  /** Fires after EVERY event with the full running reply so the caller can
   * durably persist partial progress (throttling/dedupe is the caller's; the
   * event is passed so block boundaries — tool-start after prose — can flush
   * urgently instead of leaving the tail unpersisted through a long tool run).
   * Awaited so persistence stays ordered with the stream. */
  onProgress?: (reply: string, event: AgentEvent) => void | Promise<void>;
}

export interface AgentTurnResult {
  reply: string;
  details: EventDetails;
  cancelled: boolean;
  /** Set when the event stream DIED instead of ending: abort() killing the
   * runner (a user stop), a harness crash, a provider failure mid-turn. The
   * reply/details above still hold everything that streamed — a dying stream
   * must never take the accumulated progress down with it. */
  error?: unknown;
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const isCancelled = options.isCancelled ?? (() => false);
  const details: EventDetails = {};
  let reply = "";

  try {
    for await (const event of options.runtime.send(options.input)) {
      if (isCancelled()) return { reply, details, cancelled: true };
      if (event.type === "text-delta") reply += event.delta;
      applyEventToDetails(details, event);
      options.onEvent?.(event);
      if (options.onProgress) await options.onProgress(reply, event);
    }
  } catch (error) {
    // A user stop lands HERE, not in the clean-end path: abort() makes the
    // runner report turn-error (or dies under SIGKILL), which fails the event
    // channel and throws out of the for-await. Everything accumulated so far
    // IS the turn's progress — return it alongside the error and let the
    // caller pick cancelled-vs-failed semantics. Throwing would discard the
    // reply, the tool calls, and the thinking in one line (the "stop deleted
    // everything nyari did" bug). NO PROGRESS EVER LOST.
    return { reply, details, cancelled: isCancelled(), error };
  }

  return { reply, details, cancelled: isCancelled() };
}

/** An interrupted turn (stop, stream death) can leave tools still "running" —
 * their processes died with the runner. Settle them before commit so the
 * transcript never renders a spinner that will never finish. */
export function finalizeInterruptedTools(details: EventDetails): void {
  for (const tool of details.tools ?? []) {
    if (tool.status !== "running") continue;
    tool.status = "error";
    if (tool.result === undefined) tool.result = "(interrupted — the turn ended before this tool finished)";
  }
}

export function applyEventToDetails(details: EventDetails, event: AgentEvent): void {
  switch (event.type) {
    case "model-info":
      details.model = `${event.provider}/${event.modelId}${event.subscription ? " (oauth)" : ""}`;
      return;
    case "model-fallback":
      details.modelFallback = { from: event.fromModel, to: event.toModel, reason: event.reason };
      return;
    case "text-delta":
      recordBlockEvent(details, event);
      return;
    case "thinking-start":
      details.thinkingStarted = true;
      return;
    case "thinking-delta":
      details.thinkingStarted = true;
      details.thinking = `${details.thinking ?? ""}${event.delta}`;
      recordBlockEvent(details, event);
      return;
    case "thinking-end":
      details.thinkingStarted = true;
      if (event.content && !details.thinking) details.thinking = event.content;
      recordBlockEvent(details, event);
      return;
    case "tool-start": {
      const tool = newToolDetail(event.toolCallId, event.toolName, "running", { args: event.args });
      details.tools = [...(details.tools ?? []), tool];
      recordBlockEvent(details, event, tool.id);
      return;
    }
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
        // A tool-end with no matching start (rare): create the row now AND its
        // ordered block, since tool-start never got the chance to.
        const created = newToolDetail(event.toolCallId, event.toolName, event.isError ? "error" : "complete", { result: event.result });
        details.tools = [...(details.tools ?? []), created];
        recordBlockEvent(details, event, created.id);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Fold one stream event into `details.blocks`, the ordered timeline the UI
 * renders inline. Driven purely by the uniform `AgentEvent` stream — never by a
 * harness id — so every harness (present and future) gets interleaved rendering
 * for free. Same-kind text/thinking deltas coalesce into the current block; a
 * new block opens whenever the kind changes (so thinking that resumes after a
 * tool call becomes a fresh thinking block, and prose split by a tool call
 * becomes separate text blocks). Tool blocks are emitted only when the caller
 * created a `ToolDetail` row and passes its `toolId`, keeping block order equal
 * to row-creation order. Mirror any change here in `web/src/events.js` and
 * `RoomService.applyLiveTurn` — the three folders must stay identical so the
 * live stream, the mid-turn snapshot mirror, and the committed event agree.
 */
export function recordBlockEvent(details: EventDetails, event: AgentEvent, toolId?: string): void {
  const blocks: MessageBlock[] = (details.blocks ??= []);
  const last = blocks[blocks.length - 1];
  switch (event.type) {
    case "text-delta":
      if (last && last.kind === "text") last.text += event.delta;
      else blocks.push({ kind: "text", text: event.delta });
      return;
    case "thinking-delta":
      if (last && last.kind === "thinking") last.text += event.delta;
      else blocks.push({ kind: "thinking", text: event.delta });
      return;
    case "thinking-end":
      // Thinking delivered whole (summary in `content`, no deltas): open a block
      // for it. If deltas already built one, leave their text as the record.
      if (event.content) {
        if (last && last.kind === "thinking") {
          if (!last.text) last.text = event.content;
        } else {
          blocks.push({ kind: "thinking", text: event.content });
        }
      }
      return;
    case "tool-start":
    case "tool-end":
      if (toolId) blocks.push({ kind: "tool", id: toolId });
      return;
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
