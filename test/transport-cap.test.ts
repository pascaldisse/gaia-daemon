import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentRoomEvent, RoomEvent, ToolDetail } from "../src/core/types.js";
import { capEventForTransport, capEventsForTransport } from "../src/domain/transport-cap.js";

const LIMITS = { toolBytes: 64, eventBytes: 512 };

function tool(id: string, resultBytes: number): ToolDetail {
  return { id, toolName: "bash", status: "complete", args: { cmd: "ls" }, result: "x".repeat(resultBytes) };
}

function agentEvent(tools: ToolDetail[]): RoomEvent {
  return { id: "evt", timestamp: "t", author: "astra", text: "hi", details: { tools } } as AgentRoomEvent;
}

test("an event inside the budget is returned unchanged, same object", () => {
  const event = agentEvent([tool("a", 8)]);
  assert.equal(capEventForTransport(event, LIMITS), event);
});

test("an event with no tools is untouched (user messages, system chrome)", () => {
  const user: RoomEvent = { id: "u", timestamp: "t", author: "user", text: "x".repeat(10_000) };
  assert.equal(capEventForTransport(user, LIMITS), user);
});

test("an oversized payload becomes a preview that states what was withheld", () => {
  const capped = capEventForTransport(agentEvent([tool("a", 5_000)]), LIMITS) as AgentRoomEvent;
  const out = capped.details!.tools![0]!;
  assert.equal(out.result, "x".repeat(LIMITS.toolBytes));
  assert.deepEqual(out.truncated, { bytes: 5_000, fields: ["result"] });
  // Header fields survive: a capped tool is still a readable tool row.
  assert.equal(out.toolName, "bash");
  assert.deepEqual(out.args, { cmd: "ls" });
});

test("tools past the event budget degrade to header-only stubs, newest kept", () => {
  const tools = Array.from({ length: 40 }, (_, i) => tool(`t${i}`, 5_000));
  const capped = capEventForTransport(agentEvent(tools), LIMITS) as AgentRoomEvent;
  const out = capped.details!.tools!;
  assert.equal(out.length, tools.length, "every tool still appears — truncation never drops a call");
  const last = out.at(-1)!;
  assert.equal(last.result, "x".repeat(LIMITS.toolBytes), "the newest tool keeps its preview");
  const first = out[0]!;
  assert.equal(first.result, undefined, "the oldest tool is a stub");
  assert.equal(first.id, "t0");
  assert.ok(first.truncated!.bytes > 0);
});

test("output size follows tool COUNT, not payload size — 17 MB in, ~10 KB out", () => {
  // Shaped like the real gaia-love astra event: 87 tool calls, 11.5 MB of results.
  const shape = (bytes: number) => agentEvent(Array.from({ length: 87 }, (_, i) => tool(`t${i}`, bytes)));
  const small = JSON.stringify(capEventForTransport(shape(200_000), LIMITS)).length;
  const large = JSON.stringify(capEventForTransport(shape(2_000_000), LIMITS)).length;
  assert.ok(JSON.stringify(shape(2_000_000)).length > 170_000_000);
  // Identical but for the withheld-byte NUMBERS themselves (one more digit each).
  assert.ok(large - small <= 87, `10x the payload grew the transport copy by ${large - small} bytes`);
  // Never dropped: 87 header stubs are the floor, and that is the whole ceiling.
  assert.ok(small < 16_000, `capped event was ${small} bytes`);
});

test("capping a window preserves order and event identity", () => {
  const events = [agentEvent([tool("a", 8)]), agentEvent([tool("b", 5_000)])];
  const capped = capEventsForTransport(events, LIMITS);
  assert.equal(capped.length, 2);
  assert.equal(capped[0], events[0]);
  assert.equal(capped[1]!.id, events[1]!.id);
});
