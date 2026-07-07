import test from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn, applyEventToDetails, recordBlockEvent } from "../src/services/turns.js";
import { eventDetailsFrom } from "../src/domain/rooms.js";
import type { AgentEvent, EventDetails, MessageBlock } from "../src/core/types.js";
import type { AgentInput, AgentRuntime } from "../src/harness/spec.js";

/** A runtime that just replays a fixed script of events, so we can assert the
 * ordered block timeline the accumulator builds from a stream. */
function scriptedRuntime(events: AgentEvent[]): AgentRuntime {
  return {
    async *send(_input: AgentInput): AsyncIterable<AgentEvent> {
      for (const event of events) yield event;
    },
  } as unknown as AgentRuntime;
}

const INPUT = { messages: [] } as unknown as AgentInput;

/** The kinds, in order — the thing the UI renders top-to-bottom. */
function shape(blocks: MessageBlock[] | undefined): string[] {
  return (blocks ?? []).map((b) => b.kind);
}

test("recordBlockEvent preserves the interleave: text ↔ tool ↔ text", async () => {
  const events: AgentEvent[] = [
    { type: "text-delta", delta: "Let me look. " },
    { type: "text-delta", delta: "First the config." },
    { type: "tool-start", toolName: "Read", toolCallId: "t1", args: { path: "a.ts" } },
    { type: "tool-end", toolName: "Read", toolCallId: "t1", result: "ok", isError: false },
    { type: "text-delta", delta: "Now I'll edit it." },
    { type: "tool-start", toolName: "Edit", toolCallId: "t2", args: { path: "a.ts" } },
    { type: "tool-end", toolName: "Edit", toolCallId: "t2", result: "done", isError: false },
    { type: "text-delta", delta: "All set." },
  ];
  const { reply, details } = await runAgentTurn({ runtime: scriptedRuntime(events), input: INPUT });

  // The merged reply (prompt replay / read-aloud) is untouched.
  assert.equal(reply, "Let me look. First the config.Now I'll edit it.All set.");
  // The ordered timeline reflects what actually happened — not text-then-tools.
  assert.deepEqual(shape(details.blocks), ["text", "tool", "text", "tool", "text"]);
  assert.deepEqual(
    (details.blocks ?? []).filter((b) => b.kind === "text").map((b) => (b as { text: string }).text),
    ["Let me look. First the config.", "Now I'll edit it.", "All set."],
  );
  // Tool blocks reference the tools[] rows by id.
  const toolBlockIds = (details.blocks ?? []).filter((b) => b.kind === "tool").map((b) => (b as { id: string }).id);
  assert.deepEqual(toolBlockIds, ["t1", "t2"]);
  assert.deepEqual(details.tools?.map((t) => t.id), ["t1", "t2"]);
});

test("a turn can think more than once: separate thinking blocks survive", async () => {
  const events: AgentEvent[] = [
    { type: "thinking-start" },
    { type: "thinking-delta", delta: "checking the file" },
    { type: "tool-start", toolName: "Read", toolCallId: "t1", args: { path: "a.ts" } },
    { type: "tool-end", toolName: "Read", toolCallId: "t1", result: "ok", isError: false },
    { type: "thinking-start" },
    { type: "thinking-delta", delta: "now I understand" },
    { type: "text-delta", delta: "Here's the answer." },
  ];
  const { details } = await runAgentTurn({ runtime: scriptedRuntime(events), input: INPUT });

  assert.deepEqual(shape(details.blocks), ["thinking", "tool", "thinking", "text"]);
  const thinks = (details.blocks ?? []).filter((b) => b.kind === "thinking").map((b) => (b as { text: string }).text);
  assert.deepEqual(thinks, ["checking the file", "now I understand"]);
  // The merged thinking bucket still holds everything for non-ordered consumers.
  assert.equal(details.thinking, "checking the filenow I understand");
});

test("thinking delivered whole via thinking-end content opens a block", () => {
  const details: EventDetails = {};
  recordBlockEvent(details, { type: "thinking-end", content: "summarized reasoning" });
  assert.deepEqual(shape(details.blocks), ["thinking"]);
  assert.equal((details.blocks?.[0] as { text: string }).text, "summarized reasoning");
});

test("consecutive same-kind deltas coalesce into one block", () => {
  const details: EventDetails = {};
  applyEventToDetails(details, { type: "text-delta", delta: "a" });
  applyEventToDetails(details, { type: "text-delta", delta: "b" });
  applyEventToDetails(details, { type: "text-delta", delta: "c" });
  assert.deepEqual(shape(details.blocks), ["text"]);
  assert.equal((details.blocks?.[0] as { text: string }).text, "abc");
});

test("a tool-end with no matching tool-start still records one ordered block", () => {
  const details: EventDetails = {};
  applyEventToDetails(details, { type: "text-delta", delta: "hi" });
  applyEventToDetails(details, { type: "tool-end", toolName: "Bash", toolCallId: "x1", result: "out", isError: false });
  assert.deepEqual(shape(details.blocks), ["text", "tool"]);
  assert.equal(details.tools?.length, 1);
  assert.equal((details.blocks?.[1] as { id: string }).id, "x1");
});

test("blocks round-trip through the on-disk parser, dropping empty spans", () => {
  const onDisk = {
    model: "anthropic/claude-opus-4-8 (oauth)",
    thinking: "reasoning",
    tools: [{ id: "t1", toolName: "Read", status: "complete", result: "ok" }],
    blocks: [
      { kind: "thinking", text: "reasoning" },
      { kind: "tool", id: "t1" },
      { kind: "text", text: "" }, // transient empty span → dropped
      { kind: "text", text: "the answer" },
      { kind: "bogus", text: "ignored" }, // unknown kind → dropped
      { kind: "tool", id: "" }, // idless tool → dropped
    ],
  };
  const details = eventDetailsFrom(onDisk);
  assert.ok(details);
  assert.deepEqual(shape(details.blocks), ["thinking", "tool", "text"]);
  assert.equal((details.blocks?.at(-1) as { text: string }).text, "the answer");
});

test("v1 events with no blocks parse fine (bucketed fallback)", () => {
  const details = eventDetailsFrom({ thinking: "old", tools: [{ id: "t1", toolName: "Read", status: "complete" }] });
  assert.ok(details);
  assert.equal(details.blocks, undefined);
  assert.equal(details.thinking, "old");
});
