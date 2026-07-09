import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomHandle, deriveRoomTitle, isAutoRoomId, newRoomEventId, normalizeRoomState, normalizeRoomTitle } from "../src/domain/rooms.js";
import type { PendingTurn, RoomEvent } from "../src/core/types.js";

async function openRoom(): Promise<RoomHandle> {
  const root = await mkdtemp(join(tmpdir(), "gaia-rooms-"));
  return RoomHandle.open(root, "default");
}

test("isAutoRoomId matches only the auto-created chat- prefix", () => {
  assert.equal(isAutoRoomId("chat-lx9a2-4f0b"), true);
  assert.equal(isAutoRoomId("chat-"), true);
  assert.equal(isAutoRoomId("default"), false);
  assert.equal(isAutoRoomId("incognito-lx9a2"), false);
  assert.equal(isAutoRoomId("claude-20260421-first-chat"), false);
});

test("deriveRoomTitle distills a one-line, capped title from the first message", () => {
  assert.equal(deriveRoomTitle("  fix the tab shortcut  "), "fix the tab shortcut");
  assert.equal(deriveRoomTitle("@jareth fix the tab shortcut"), "fix the tab shortcut");
  assert.equal(deriveRoomTitle("line one\nline two\nline three"), "line one");
  assert.equal(deriveRoomTitle("   \n\t  "), ""); // whitespace-only → untitled
  assert.equal(deriveRoomTitle(""), "");
  const long = "a".repeat(80);
  const title = deriveRoomTitle(long);
  assert.equal(title.length, 48);
  assert.ok(title.endsWith("…"));
});

test("normalizeRoomTitle cleans model/manual title proposals", () => {
  assert.equal(normalizeRoomTitle('"Room rename UX."'), "Room rename UX");
  assert.equal(normalizeRoomTitle("first line\nignored line"), "first line");
  assert.equal(normalizeRoomTitle("   "), "");
});

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

test("queue: enqueue/peek/splice/clear are durable", async () => {
  const room = await openRoom();
  await room.enqueue({ taskId: "t1", text: "one", targets: ["gaia"], queuedAt: "2026-01-01" });
  await room.enqueue({ taskId: "t2", text: "two", targets: ["terry"], queuedAt: "2026-01-01" });

  // Durability: a fresh handle (fresh process) sees the queue.
  const reopened = await RoomHandle.open(room.workspaceRoot, room.roomId);
  const state = await reopened.state();
  assert.equal(state.queue?.length, 2);

  const head = await reopened.peekQueue();
  assert.equal(head?.taskId, "t1");
  assert.equal((await reopened.state()).queue?.length, 2, "peek never removes — the entry survives until a successor record consumes it");

  await reopened.spliceQueued("t1");
  const rest = await reopened.state();
  assert.equal(rest.queue?.length, 1);
  await reopened.spliceQueued("t1"); // idempotent
  assert.equal((await reopened.state()).queue?.length, 1);

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
  await room.commitTurn(event);

  const state = await room.state();
  assert.equal(state.pendingTurn, undefined);
  assert.equal(state.agentCursors.gaia, 1, "cursor = just past the reply's own line");
  const { events } = await room.eventsFrom(0);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, eventId);
  assert.equal((events[0] as { details?: { model?: string } }).details?.model, "pi/deepseek");

  // Idempotence: committing again never duplicates the transcript line.
  await room.commitTurn(event);
  assert.equal((await room.eventsFrom(0)).events.length, 1);
});

test("WAL: the commit cursor sweeps mid-turn steers but never events appended after the reply", async () => {
  const room = await openRoom();
  await room.addUserMessage("start", ["gaia"]); // line 0
  const eventId = newRoomEventId();
  await room.markPendingTurn({ id: "task1", eventId, prompt: "start", targets: ["gaia"], agentId: "gaia", partialReply: "", startedAt: "now" });
  // Two steers land DURING the turn (delivered live into it) — lines 1, 2.
  const steer1 = await room.addUserMessage("go left", ["gaia"]);
  const steer2 = await room.addUserMessage("actually right", ["gaia"]);
  await room.commitTurn({ id: eventId, timestamp: "t", author: "gaia", text: "done" }); // line 3
  // A note lands AFTER the reply (never seen by the live turn) — line 4.
  await room.appendEvent({ id: newRoomEventId(), timestamp: "t", author: "terry", text: "post-commit note" });

  const cursor = (await room.state()).agentCursors.gaia;
  assert.equal(cursor, 4, "cursor = reply line + 1: steers + own reply swept, later note not");
  const { events: replay } = await room.eventsFrom(cursor);
  assert.ok(!replay.some((e) => e.id === steer1.id || e.id === steer2.id || e.id === eventId), "steers and the reply never replay as fresh context");
  assert.ok(replay.some((e) => e.text === "post-commit note"), "the unseen post-reply event still replays");
});

test("WAL: commitTurn swaps in the next target's marker in the same atomic write (multi-target hand-off)", async () => {
  const room = await openRoom();
  const eventId = newRoomEventId();
  await room.markPendingTurn({ id: "task1", eventId, prompt: "hi", targets: ["gaia", "terry"], agentId: "gaia", partialReply: "", startedAt: "now" });
  const next: PendingTurn = { id: "task1", prompt: "hi", targets: ["terry"], agentId: "terry", partialReply: "", startedAt: "now" };
  await room.commitTurn({ id: eventId, timestamp: "t", author: "gaia", text: "gaia's reply" }, next);
  const state = await room.state();
  assert.equal(state.pendingTurn?.agentId, "terry", "remaining target's owed turn is durable the instant gaia's commit lands");
});

test("queue: two-phase hand-off — peek leaves the entry, assignQueuedEventId reserves the id, markPendingTurn consumes it atomically", async () => {
  const room = await openRoom();
  await room.enqueue({ taskId: "q1", text: "queued msg", targets: ["gaia"], queuedAt: "2026-01-01" });

  const head = await room.peekQueue();
  assert.equal(head?.taskId, "q1");
  assert.equal((await room.state()).queue?.length, 1, "peek never removes");

  await room.assignQueuedEventId("q1", "evt_reserved");
  assert.equal((await room.state()).queue?.[0].eventId, "evt_reserved", "reserved id is durable before the append");

  await room.markPendingTurn(
    { id: "q1", eventId: "evt_reply", prompt: "queued msg", targets: ["gaia"], agentId: "gaia", partialReply: "", startedAt: "now" },
    { consumeQueuedTaskId: "q1" },
  );
  const state = await room.state();
  assert.equal(state.queue, undefined, "entry consumed in the same write that created the marker");
  assert.equal(state.pendingTurn?.id, "q1");

  // Idempotent: a second consume (multi-target loop) is a no-op.
  await room.markPendingTurn(
    { id: "q1", eventId: "evt_reply2", prompt: "queued msg", targets: ["terry"], agentId: "terry", partialReply: "", startedAt: "now" },
    { consumeQueuedTaskId: "q1" },
  );
  assert.equal((await room.state()).queue, undefined);
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

test("attachments survive normalization on pendingTurn and queue; malformed entries drop", () => {
  const good = { name: "a.png", mime: "image/png", size: 3, path: "/x/a.png" };
  const state = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    pendingTurn: {
      id: "t1",
      prompt: "p",
      targets: ["gaia"],
      agentId: "gaia",
      partialReply: "",
      startedAt: "",
      attachments: [good, { bad: true }],
    },
    queue: [{ taskId: "q1", text: "hi", targets: [], attachments: [good], queuedAt: "" }],
  });
  assert.deepEqual(state.pendingTurn?.attachments, [good]);
  assert.deepEqual(state.queue?.[0].attachments, [good]);
});

test("redactEvents: rewrites text in place, preserves originals in redactions.jsonl, keeps line count", async () => {
  const room = await openRoom();
  const first = await room.addUserMessage("talk about IDA Pro exploits", ["gaia"]);
  const reply: RoomEvent = { id: newRoomEventId(), timestamp: "2026-01-01", author: "gaia", text: "sure, IDA Pro it is" };
  await room.appendEvent(reply);
  const second = await room.addUserMessage("and more reversing", ["gaia"]);

  const edited = await room.redactEvents(
    new Map([
      [first.id, "talk about retro games"],
      [reply.id, reply.text], // no-op text → ignored
      ["evt_unknown", "whatever"], // unknown id → ignored
    ]),
  );
  assert.deepEqual(edited, [first.id]);

  const { events, nextCursor } = await room.eventsFrom(0);
  assert.equal(events.length, 3); // same line count — cursors stay valid
  assert.equal(nextCursor, 3);
  assert.equal(events[0].text, "talk about retro games");
  assert.equal(events[0].redacted, true);
  assert.equal(events[1].text, "sure, IDA Pro it is");
  assert.equal(events[1].redacted, undefined);
  assert.equal(events[2].id, second.id);

  // Original preserved verbatim, append-only, beside the transcript.
  const preserved = (await readFile(join(room.workspaceRoot, ".gaia", "rooms", room.roomId, "redactions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].id, first.id);
  assert.equal(preserved[0].text, "talk about IDA Pro exploits");
  assert.equal(preserved[0].redacted, undefined);

  // The redacted flag survives a re-read from disk (roomEventFrom passthrough).
  const reopened = await RoomHandle.open(room.workspaceRoot, room.roomId);
  const fresh = await reopened.eventsFrom(0);
  assert.equal(fresh.events[0].redacted, true);
});

test("normalizeRoomState: thanksDario flag survives the whitelist", () => {
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, thanksDario: true }).thanksDario, true);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, thanksDario: "yes" }).thanksDario, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).thanksDario, undefined);
});

test("normalizeRoomState: incognito flag survives the whitelist (only literal true)", () => {
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, incognito: true }).incognito, true);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, incognito: "yes" }).incognito, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).incognito, undefined);
});

test("normalizeRoomState: title metadata and imported survive the whitelist", () => {
  const state = normalizeRoomState({ activeRoles: {}, agentCursors: {}, title: "My chat", titleSource: "manual", imported: "2026-04-21T00:00:00Z" });
  assert.equal(state.title, "My chat");
  assert.equal(state.titleSource, "manual");
  assert.equal(state.imported, "2026-04-21T00:00:00Z");
  const junk = normalizeRoomState({ activeRoles: {}, agentCursors: {}, title: "   ", titleSource: "weird", imported: 42 });
  assert.equal(junk.title, undefined);
  assert.equal(junk.titleSource, undefined);
  assert.equal(junk.imported, undefined);
});

test("normalizeRoomState: a held contextGate survives the whitelist, malformed drops", () => {
  const state = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    contextGate: { agentId: "nyari", message: "@nyari hi", estTokens: 150_000, totalEvents: 42, window: 1_000_000, at: "2026-07-04T00:00:00Z" },
  });
  assert.equal(state.contextGate?.agentId, "nyari");
  assert.equal(state.contextGate?.estTokens, 150_000);
  assert.equal(state.contextGate?.totalEvents, 42);
  assert.equal(state.contextGate?.window, 1_000_000);
  // No agent id → the whole block drops (never blocks the room from opening).
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, contextGate: { message: "x" } }).contextGate, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).contextGate, undefined);
});

test("normalizeRoomState: per-agent contextUsage survives the whitelist, malformed entries drop", () => {
  const state = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    contextUsage: {
      ari: { usedTokens: 22_000, maxTokens: 1_000_000 }, // claude, 1M window
      terry: { usedTokens: 5_432.9 }, // codex — no window reported yet; floored, kept
      bad1: { usedTokens: "lots" }, // non-numeric → dropped
      bad2: { usedTokens: -1 }, // negative → dropped
      bad3: { usedTokens: 10, maxTokens: 0 }, // zero window → usedTokens kept, maxTokens dropped
    },
  });
  assert.deepEqual(state.contextUsage?.ari, { usedTokens: 22_000, maxTokens: 1_000_000 });
  assert.deepEqual(state.contextUsage?.terry, { usedTokens: 5_432 });
  assert.equal(state.contextUsage?.bad1, undefined);
  assert.equal(state.contextUsage?.bad2, undefined);
  assert.deepEqual(state.contextUsage?.bad3, { usedTokens: 10 });
  // Nothing salvageable → the block is absent entirely, not an empty object.
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, contextUsage: { x: 1 } }).contextUsage, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).contextUsage, undefined);
});
