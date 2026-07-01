import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomHandle, newRoomEventId, normalizeRoomState } from "../src/domain/rooms.js";
import type { PendingTurn, RoomEvent } from "../src/core/types.js";

async function openRoom(): Promise<RoomHandle> {
  const root = await mkdtemp(join(tmpdir(), "gaia-rooms-"));
  return RoomHandle.open(root, "default");
}

test("normalizeRoomState accepts v1 shapes and drops malformed blocks", () => {
  const state = normalizeRoomState({
    activeRoles: { gaia: "brainstorm", bad: 42 },
    agentCursors: { gaia: 3.7, neg: -1 },
    runtimeDetails: { evt_1: { model: "openai/gpt", tools: [{ id: "t1", toolName: "bash", status: "weird" }] } },
    parentRoomId: "  ",
    monad: { policy: "", slots: [] },
    pendingTurn: { id: "t", prompt: "p", agentId: "a", targets: [] },
    queue: [{ taskId: "q1", text: "hello", targets: ["gaia"] }, { nope: true }],
  });
  assert.deepEqual(state.activeRoles, { gaia: "brainstorm" });
  assert.deepEqual(state.agentCursors, { gaia: 3 });
  assert.equal(state.runtimeDetails?.evt_1.model, "openai/gpt");
  assert.equal(state.runtimeDetails?.evt_1.tools?.[0].status, "complete");
  assert.equal(state.parentRoomId, undefined);
  assert.equal(state.monad, undefined);
  assert.equal(state.pendingTurn, undefined); // empty targets → invalid
  assert.equal(state.queue?.length, 1);
  assert.equal(state.queue?.[0].taskId, "q1");
});

test("queue: enqueue/dequeue/clear are durable", async () => {
  const room = await openRoom();
  await room.enqueue({ taskId: "t1", text: "one", targets: ["gaia"], queuedAt: "2026-01-01" });
  await room.enqueue({ taskId: "t2", text: "two", targets: ["terry"], queuedAt: "2026-01-01" });

  // Durability: a fresh handle (fresh process) sees the queue.
  const reopened = await RoomHandle.open(room.workspaceRoot, room.roomId);
  const state = await reopened.state();
  assert.equal(state.queue?.length, 2);

  const head = await reopened.dequeue();
  assert.equal(head?.taskId, "t1");
  const rest = await reopened.state();
  assert.equal(rest.queue?.length, 1);

  const dropped = await reopened.clearQueue();
  assert.equal(dropped.length, 1);
  assert.equal((await reopened.state()).queue, undefined);
});

test("WAL: commitTurn appends the reserved event with details and advances the cursor atomically", async () => {
  const room = await openRoom();
  const eventId = newRoomEventId();
  await room.markPendingTurn({ id: "task1", eventId, prompt: "hi", targets: ["gaia"], agentId: "gaia", partialReply: "", startedAt: "now" });
  await room.flushPartialReply("partial…");

  const midway = await RoomHandle.open(room.workspaceRoot, room.roomId);
  assert.equal((await midway.state()).pendingTurn?.partialReply, "partial…");

  const event: RoomEvent = {
    id: eventId,
    timestamp: new Date().toISOString(),
    author: "gaia",
    text: "the reply",
    details: { model: "pi/deepseek", tools: [{ id: "t", toolName: "bash", status: "complete" }] },
  };
  await room.commitTurn(event, 2);

  const state = await room.state();
  assert.equal(state.pendingTurn, undefined);
  assert.equal(state.agentCursors.gaia, 2);
  const { events } = await room.eventsFrom(0);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, eventId);
  assert.equal((events[0] as { details?: { model?: string } }).details?.model, "pi/deepseek");

  // Idempotence: committing again never duplicates the transcript line.
  await room.commitTurn(event, 2);
  assert.equal((await room.eventsFrom(0)).events.length, 1);
});

test("WAL: resumeMode distinguishes committed-but-unacknowledged from needs-rerun", async () => {
  const room = await openRoom();
  const eventId = newRoomEventId();
  const pending: PendingTurn = { id: "task1", eventId, prompt: "hi", targets: ["gaia"], agentId: "gaia", partialReply: "some text", startedAt: "now" };

  // Nothing in the transcript yet → the turn must re-run.
  assert.equal(await room.resumeMode(pending), "rerun");

  // Crash landed between append and the state write → only finish the commit.
  await room.appendEvent({ id: eventId, timestamp: "t", author: "gaia", text: "done" });
  assert.equal(await room.resumeMode(pending), "finish-commit");

  // Legacy pendingTurn without an eventId (v1 record) → rerun path.
  assert.equal(await room.resumeMode({ ...pending, eventId: undefined }), "rerun");
});

test("legacy v1 side-table details merge onto events on read", async () => {
  const room = await openRoom();
  await room.appendEvent({ id: "evt_a", timestamp: "t", author: "gaia", text: "hello" });
  await room.updateState((state) => {
    state.runtimeDetails = { evt_a: { model: "anthropic/claude", thinking: "hmm" } };
  });
  const { events } = await room.eventsFrom(0);
  const details = (events[0] as { details?: { model?: string; thinking?: string } }).details;
  assert.equal(details?.model, "anthropic/claude");
  assert.equal(details?.thinking, "hmm");
});

test("transcript: pre-id lines get stable legacy ids; bad lines are skipped but counted", async () => {
  const room = await openRoom();
  const { appendFile } = await import("node:fs/promises");
  await appendFile(room.transcriptPath, `${JSON.stringify({ timestamp: "t", author: "user", targets: [], text: "old" })}\nnot json\n`, "utf8");
  await room.appendEvent({ id: "evt_new", timestamp: "t", author: "gaia", text: "new" });

  const { events, nextCursor } = await room.eventsFrom(0);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, "legacy_0");
  assert.equal(events[1].id, "evt_new");
  assert.equal(nextCursor, 3); // the unparseable line still counts for cursors

  // Cursor stability: reading from cursor 1 skips the legacy line only.
  const page = await room.eventsFrom(1);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].id, "evt_new");
});

test("clearTranscript empties the log; state survives", async () => {
  const room = await openRoom();
  await room.addUserMessage("hello", ["gaia"]);
  await room.updateState((state) => {
    state.activeRoles.gaia = "planner";
  });
  await room.clearTranscript();
  assert.equal((await readFile(room.transcriptPath, "utf8")).trim(), "");
  assert.equal((await room.state()).activeRoles.gaia, "planner");
});

test("single-writer: concurrent state updates serialize", async () => {
  const room = await openRoom();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      room.updateState((state) => {
        state.agentCursors[`agent${i}`] = i;
        state.agentCursors.total = (state.agentCursors.total ?? 0) + 1;
      }),
    ),
  );
  const state = await RoomHandle.open(room.workspaceRoot, room.roomId).then((r) => r.state());
  assert.equal(state.agentCursors.total, 20);
});
