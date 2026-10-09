import { test } from "bun:test";
import assert from "node:assert/strict";
import { thinkingReplayExtension } from "../src/harness/pi/thinking-replay.ts";

// Capture the `context` handler the factory registers on a fake ExtensionAPI.
function contextHandler() {
  let handler: ((event: { messages: unknown[] }) => unknown) | undefined;
  thinkingReplayExtension()({ on: (name: string, fn: typeof handler) => { if (name === "context") handler = fn; } } as never);
  assert.ok(handler, "context handler registered");
  return handler!;
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (...content: unknown[]) => ({ role: "assistant", content, timestamp: 0 });
const thinking = (text: string) => ({ type: "thinking", thinking: text, thinkingSignature: "sig" });
const text = (value: string) => ({ type: "text", text: value });
const call = { type: "toolCall", id: "t1", name: "read", arguments: {} };

test("strips thinking from assistant turns before the last user message", () => {
  const handle = contextHandler();
  const messages = [
    user("old"),
    assistant(thinking("old reasoning"), text("old answer")),
    user("new"),
  ];
  const result = handle({ messages }) as { messages: Array<{ content: unknown[] }> };
  assert.ok(result, "changed");
  assert.deepEqual(result.messages[1]!.content, [text("old answer")]);
  assert.equal(result.messages.length, 3);
});

test("keeps thinking inside the current turn's tool loop", () => {
  const handle = contextHandler();
  const current = assistant(thinking("live reasoning"), call);
  const messages = [user("old"), assistant(thinking("old"), text("done")), user("new"), current];
  const result = handle({ messages }) as { messages: Array<{ content: unknown[] }> } | undefined;
  assert.ok(result, "prior turn changed");
  assert.deepEqual(result.messages[3], current, "current-turn assistant untouched");
});

test("returns undefined when nothing needs stripping", () => {
  const handle = contextHandler();
  assert.equal(handle({ messages: [user("a"), assistant(text("b")), user("c")] }), undefined);
  assert.equal(handle({ messages: [user("only")] }), undefined);
});

test("never mutates the input messages", () => {
  const handle = contextHandler();
  const old = assistant(thinking("keep me in source"), text("x"));
  const messages = [user("a"), old, user("b")];
  handle({ messages });
  assert.equal(old.content.length, 2, "source assistant still has its thinking block");
});
