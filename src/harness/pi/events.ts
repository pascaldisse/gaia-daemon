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
// Lane E (chat-mto9n58s-bjr1, docs/PLUGIN-ADVERSARY-0905.md §top-fix-3): the
// harness.event fallback below carries an arbitrary pi SDK event object over
// the wire as JSON — depth/size-capped so a cyclic or huge internal event can
// never blow up a client or the transcript store. `maxBytes` is a caller-
// overridable param (never hardcoded network-wide), default 32KB.
const DEFAULT_HARNESS_EVENT_MAX_BYTES = 32 * 1024;
function safePayload(value: unknown, maxBytes = DEFAULT_HARNESS_EVENT_MAX_BYTES, maxDepth = 6): unknown {
  const seen = new WeakSet<object>();
  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input !== "object") return typeof input === "function" ? undefined : input;
    if (depth >= maxDepth) return "[depth-limit]";
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input instanceof Error) return { name: input.name, message: input.message };
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      if (typeof val === "function") continue;
      out[key] = walk(val, depth + 1);
    }
    return out;
  };
  const safe = walk(value, 0);
  const json = JSON.stringify(safe) ?? "null";
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return safe;
  return { truncated: true, preview: json.slice(0, maxBytes) };
}
export function forwardPiEvent(event: any, session: PiSessionLike, channel: Channel): void {
  let handled = false;
  if (event.type === "message_start" && event.message.role === "user") { const text = piUserMessageText(event.message); const skill = text && parseSkillBlock(text); if (skill) { channel.push({ type: "skill-invocation", skill: { name: skill.name, location: skill.location, content: skill.content } }); handled = true; } }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { channel.push({ type: "text-delta", delta: event.assistantMessageEvent.delta }); handled = true; }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") { channel.push({ type: "thinking-start" }); handled = true; }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") { channel.push({ type: "thinking-delta", delta: event.assistantMessageEvent.delta }); handled = true; }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") { channel.push({ type: "thinking-end", content: event.assistantMessageEvent.content }); handled = true; }
  if (event.type === "tool_execution_start") { channel.push({ type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args }); handled = true; }
  if (event.type === "tool_execution_update") { channel.push({ type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult }); handled = true; }
  if (event.type === "tool_execution_end") { channel.push({ type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError }); handled = true; }
  if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") { channel.fail(new Error(event.message.errorMessage || "model request failed")); handled = true; }
  if (event.type === "message_end" && event.message.role === "assistant") { const usage = session.getContextUsage?.(); if (usage && usage.tokens !== null) channel.push({ type: "context-usage", usedTokens: usage.tokens, maxTokens: usage.contextWindow }); handled = true; }
  // Every other pi ExtensionEvent kind (session_start/session_shutdown/
  // agent_start/agent_end/agent_settled/turn_start/turn_end/model_select/
  // thinking_level_select/user_bash/input/before_agent_start/a non-role/
  // non-subtype variant of the cases above/…) had NO case above and was
  // silently dropped (docs/PLUGIN-ADVERSARY-0905.md §1/§top-fix-3) — instead
  // it now surfaces as a generic, visible passthrough event.
  if (!handled) channel.push({ type: "harness.event", kind: typeof event?.type === "string" ? event.type : "unknown", payload: safePayload(event) });
}
