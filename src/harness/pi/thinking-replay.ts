import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// Anthropic binds each thinking signature to the prefix it was generated under.
// Any later rewrite of earlier content (memory block, compaction summary) makes
// a replayed thinking block invalid → 400 "Invalid `signature` in `thinking`
// block ... bound to a different conversation". Anthropic itself drops thinking
// from prior user turns; this mirrors that request-locally.
//
// Scope: assistant messages BEFORE the last user message only. Thinking inside
// the current turn (tool-use loop) is left intact. The `context` event is
// request-local — session files are never rewritten.
export function thinkingReplayExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const messages = event.messages;
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") { lastUser = i; break; }
      }
      if (lastUser <= 0) return;
      let changed = false;
      const out = messages.map((message, index) => {
        if (index >= lastUser || message.role !== "assistant" || !Array.isArray(message.content)) return message;
        const content = message.content.filter((block) => block.type !== "thinking");
        if (content.length === message.content.length) return message;
        changed = true;
        return { ...message, content };
      });
      return changed ? { messages: out } : undefined;
    });
  };
}
