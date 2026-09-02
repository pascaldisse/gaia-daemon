// Pi SDK event → harness-neutral AgentEvent boundary.
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../../core/types.js";
import type { PiSessionLike } from "./session.js";
type Channel = { push(event: AgentEvent): void; fail(cause: unknown): void };
function piUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"));
  return text?.text;
}
export function forwardPiEvent(event: any, session: PiSessionLike, channel: Channel): void {
  if (event.type === "message_start" && event.message.role === "user") { const text = piUserMessageText(event.message); const skill = text && parseSkillBlock(text); if (skill) channel.push({ type: "skill-invocation", skill: { name: skill.name, location: skill.location, content: skill.content } }); }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") channel.push({ type: "text-delta", delta: event.assistantMessageEvent.delta });
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") channel.push({ type: "thinking-start" });
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") channel.push({ type: "thinking-delta", delta: event.assistantMessageEvent.delta });
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") channel.push({ type: "thinking-end", content: event.assistantMessageEvent.content });
  if (event.type === "tool_execution_start") channel.push({ type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
  if (event.type === "tool_execution_update") channel.push({ type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult });
  if (event.type === "tool_execution_end") channel.push({ type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError });
  if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") channel.fail(new Error(event.message.errorMessage || "model request failed"));
  if (event.type === "message_end" && event.message.role === "assistant") { const usage = session.getContextUsage?.(); if (usage && usage.tokens !== null) channel.push({ type: "context-usage", usedTokens: usage.tokens, maxTokens: usage.contextWindow }); }
}
