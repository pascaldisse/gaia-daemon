import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomHandle, deriveRoomTitle, isAutoRoomId, newRoomEventId, normalizeRoomState, normalizeRoomTitle } from "../src/domain/rooms.js";
import { initWorkspace, loadWorkspace } from "../src/domain/workspace.js";
import { activateSetup } from "../src/services/setups.js";
import type { PendingTurn, RoomEvent } from "../src/core/types.js";
import { openSqlite, withSqliteImmediateLock } from "../src/core/sqlite.js";
import { workspacePaths } from "../src/core/paths.js";

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
  assert.equal(state.conversationEndedAgents, undefined);
});

test("normalizeRoomState retains only valid agent conversation-end markers", () => {
  const state = normalizeRoomState({
    activeRoles: {},
    thinkingOverrides: {},
    agentCursors: {},
    conversationEndedAgents: { gaia: "2026-08-29T12:00:00.000Z", empty: "", bad: 42 },
  });
  assert.deepEqual(state.conversationEndedAgents, { gaia: "2026-08-29T12:00:00.000Z" });
});

test("normalizeRoomState preserves queue hand-off markers across restart", () => {
  const state = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    queue: [{
      taskId: "q1",
      text: "continue goal",
      targets: ["gaia"],
      queuedAt: "2026-08-04T15:00:00.000Z",
      eventId: "evt_user_1",
      recorded: true,
      nativeCommand: true,
      goalStartedAt: "2026-08-04T14:59:00.000Z",
    }],
  });
  assert.deepEqual(state.queue?.[0], {
    taskId: "q1",
    text: "continue goal",
    targets: ["gaia"],
    queuedAt: "2026-08-04T15:00:00.000Z",
    eventId: "evt_user_1",
    recorded: true,
    nativeCommand: true,
    goalStartedAt: "2026-08-04T14:59:00.000Z",
  });
});

test("normalizeRoomState preserves future custody metadata without accepting malformed known fields", () => {
  const state = normalizeRoomState({
    pendingTurn: {
      id: "pending",
      eventId: "evt_reply",
      prompt: "continue",
      targets: ["gaia"],
      agentId: "gaia",
      partialReply: "",
      startedAt: "1",
      monad: true,
      futurePending: { protocol: 3 },
    },
    queue: [{
      taskId: "queued",
      text: "later",
      targets: ["gaia"],
      queuedAt: "1",
      recorded: "invalid",
      futureCustody: { protocol: 3 },
      attachments: [{ name: "proof", path: "/proof", mime: "text/plain", size: 1, futureAttachment: true }],
    }],
  });
  assert.equal(state.pendingTurn?.monad, true);
  assert.deepEqual((state.pendingTurn as unknown as { futurePending: unknown }).futurePending, { protocol: 3 });
  assert.equal(state.queue?.[0].recorded, undefined);
  assert.deepEqual((state.queue?.[0] as unknown as { futureCustody: unknown }).futureCustody, { protocol: 3 });
  assert.equal((state.queue?.[0].attachments?.[0] as unknown as { futureAttachment: boolean }).futureAttachment, true);
});

test("normalizeRoomState round-trips a summon record's resumeStatus/resumeStartedAt (Fix #1) and drops malformed values", () => {
  const withResume = normalizeRoomState({
    parentRoomId: "default",
    summon: {
      agentId: "terry",
      deliver: "turn",
      callerAgentId: "gaia",
      status: "delivered",
      launchedAt: "2026-01-01T00:00:00.000Z",
      resumeStatus: "running",
      resumeStartedAt: "2026-01-02T00:00:00.000Z",
    },
  });
  assert.equal(withResume.summon?.resumeStatus, "running");
  assert.equal(withResume.summon?.resumeStartedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(withResume.summon?.status, "delivered", "resumeStatus is independent of the first-turn status field");

  // No resume ever tracked: the field stays ABSENT, never defaulted —
  // distinguishes "never resumed" from "a resume is in flight".
  const noResume = normalizeRoomState({
    parentRoomId: "default",
    summon: { agentId: "terry", deliver: "note", status: "delivered", launchedAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(noResume.summon?.resumeStatus, undefined);
  assert.equal("resumeStatus" in (noResume.summon ?? {}), false);

  // Malformed resumeStatus is dropped, not laundered into a bogus value.
  const malformed = normalizeRoomState({
    parentRoomId: "default",
    summon: {
      agentId: "terry",
      deliver: "note",
      status: "delivered",
      launchedAt: "2026-01-01T00:00:00.000Z",
      resumeStatus: "bogus",
      resumeStartedAt: 12345,
    },
  });
  assert.equal(malformed.summon?.resumeStatus, undefined);
  assert.equal((malformed.summon as unknown as { resumeStartedAt?: unknown })?.resumeStartedAt, undefined);
});

test("normalizeRoomState keeps bounded JSON plugin state and drops executable shapes", () => {
  const state = normalizeRoomState({
    pluginState: { rpg: { gm: "terra", roster: [{ name: "Ada" }], ignored: () => "no" } },
  });
  assert.deepEqual(state.pluginState, { rpg: { gm: "terra", roster: [{ name: "Ada" }] } });
});

test("normalizeRoomState round-trips thinkingOverrides (mirrors activeRoles)", () => {
  const state = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    thinkingOverrides: { gaia: "high", bad: 42 },
  });
  assert.deepEqual(state.thinkingOverrides, { gaia: "high" });
  // Absent block still normalizes to an empty record, never undefined —
  // callers index it directly (state.thinkingOverrides[agentId]).
  assert.deepEqual(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).thinkingOverrides, {});
  assert.deepEqual(normalizeRoomState(undefined).thinkingOverrides, {});
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

test("commitTurn appends after legacy and damaged lines without rewriting them", async () => {
  const room = await openRoom();
  const legacy = `${JSON.stringify({ timestamp: "t", author: "user", targets: [], text: "legacy" })}\nnot json\n`;
  await writeFile(room.transcriptPath, legacy, "utf8");
  await room.markPendingTurn({ id: "legacy-task", eventId: "legacy-reply", prompt: "p", targets: ["gaia"], agentId: "gaia", partialReply: "", startedAt: "t" });
  await room.commitTurn({ id: "legacy-reply", timestamp: "t", author: "gaia", text: "continued" });

  assert.ok((await readFile(room.transcriptPath, "utf8")).startsWith(legacy), "legacy bytes were rewritten");
  assert.deepEqual((await room.eventsFrom(0)).events.map((event) => event.text), ["legacy", "continued"]);
  assert.equal((await room.state()).pendingTurn, undefined);
});

test("clearRoom empties the log; unrelated state survives", async () => {
  const room = await openRoom();
  await room.addUserMessage("hello", ["gaia"]);
  await room.updateState((state) => {
    state.activeRoles.gaia = "planner";
  });
  await room.clearRoom();
  assert.equal((await readFile(room.transcriptPath, "utf8")).trim(), "");
  assert.equal((await room.state()).activeRoles.gaia, "planner");
});

test("clearRoom fails closed on malformed bytes", async () => {
  const room = await openRoom();
  const raw = '{"id":"good","timestamp":"t","author":"user","targets":[],"text":"kept"}\nnot json\n';
  await writeFile(room.transcriptPath, raw);
  await assert.rejects(room.clearRoom(), /malformed raw line/);
  assert.equal(await readFile(room.transcriptPath, "utf8"), raw);
});

test("transcript rewrites fail closed on future nested event metadata", async () => {
  const room = await openRoom();
  const raw = `${JSON.stringify({
    id: "future-details",
    timestamp: "t",
    author: "gaia",
    text: "keep all metadata",
    details: { model: "test", futureProtocol: { version: 2 } },
  })}\n`;
  await writeFile(room.transcriptPath, raw);
  await assert.rejects(room.clearRoom(), /noncanonical raw line/);
  assert.equal(await readFile(room.transcriptPath, "utf8"), raw);
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

test("independent room handles share one failure-safe state writer", async () => {
  const first = await openRoom();
  const second = await RoomHandle.open(first.workspaceRoot, first.roomId);

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? first : second).updateState((state) => {
      state.agentCursors[`shared${index}`] = index;
      state.agentCursors.total = (state.agentCursors.total ?? 0) + 1;
    })),
  );
  assert.equal((await first.state()).agentCursors.total, 20);
  assert.equal(Object.keys((await second.state()).agentCursors).filter((key) => key.startsWith("shared")).length, 20);

  await assert.rejects(first.updateState(() => { throw new Error("boom"); }), /boom/);
  await second.updateState((state) => { state.activeRoles.gaia = "review"; });
  assert.equal((await first.state()).activeRoles.gaia, "review");
});

test("cross-process updateState retains every independently written delta", async () => {
  const room = await openRoom();
  const barrier = join(room.workspaceRoot, "barrier");
  await mkdir(barrier);
  const agents = Array.from({ length: 16 }, (_, index) => `process${index}`);
  const worker = join(import.meta.dir, "helpers", "room-update-racer.ts");
  const racers = agents.map((agent) => Bun.spawn([process.execPath, worker, room.workspaceRoot, agent, barrier]));

  const deadline = Date.now() + 5_000;
  while (agents.some((agent) => !existsSync(join(barrier, `${agent}.ready`)))) {
    assert.ok(Date.now() < deadline, "all child processes reached the pre-update barrier");
    await Bun.sleep(5);
  }
  await writeFile(join(barrier, "release"), "", "utf8");
  const exits = await Promise.all(racers.map((racer) => racer.exited));
  assert.deepEqual(exits, agents.map(() => 0));

  const persisted = await RoomHandle.open(room.workspaceRoot, room.roomId).then((handle) => handle.state());
  const survivors = agents.filter((agent) => persisted.agentCursors[agent] === 1);
  assert.deepEqual(survivors, agents, `every concurrent delta survives: wrote ${agents.length}, persisted ${survivors.length}`);
});

test("cross-process same-key increments lose no update", async () => {
  const room = await openRoom();
  const barrier = join(room.workspaceRoot, "inc-barrier");
  await mkdir(barrier);
  const agents = Array.from({ length: 16 }, (_, index) => `inc${index}`);
  const worker = join(import.meta.dir, "helpers", "room-update-racer.ts");
  const racers = agents.map((agent) => Bun.spawn([process.execPath, worker, room.workspaceRoot, agent, barrier, "increment"]));

  const deadline = Date.now() + 5_000;
  while (agents.some((agent) => !existsSync(join(barrier, `${agent}.ready`)))) {
    assert.ok(Date.now() < deadline, "all child processes reached the pre-update barrier");
    await Bun.sleep(5);
  }
  await writeFile(join(barrier, "release"), "", "utf8");
  assert.deepEqual(await Promise.all(racers.map((racer) => racer.exited)), agents.map(() => 0));

  const persisted = await RoomHandle.open(room.workspaceRoot, room.roomId).then((handle) => handle.state());
  assert.equal(persisted.agentCursors.total, agents.length, "read-modify-write increments serialize across processes");
});

test("opening an existing room is read-only: no lock sidecar, no state rewrite", async () => {
  const room = await openRoom();
  const lockPath = `${room.statePath}.lock.sqlite`;
  await rm(lockPath, { force: true });
  const bytes = await readFile(room.statePath, "utf8");

  const roomDir = join(room.statePath, "..");
  await chmod(roomDir, 0o555);
  try {
    const reopened = await RoomHandle.open(room.workspaceRoot, room.roomId);
    assert.deepEqual(await reopened.state(), normalizeRoomState(JSON.parse(bytes)));
  } finally {
    await chmod(roomDir, 0o755);
  }
  assert.equal(await readFile(room.statePath, "utf8"), bytes, "opening an existing room rewrites no bytes");
  assert.equal(existsSync(lockPath), false, "no lock database is created just to read a room");
});

test("updateState preserves the lock sidecar's journal mode and ignores unknown keys", async () => {
  const room = await openRoom();
  const lockPath = `${room.statePath}.lock.sqlite`;
  await room.updateState((state) => { state.agentCursors.first = 1; });
  const db = openSqlite(lockPath);
  try { db.exec("PRAGMA journal_mode = WAL"); } finally { db.close(); }

  await room.updateState((state) => { state.agentCursors.second = 2; });
  const check = openSqlite(lockPath);
  let mode: unknown;
  try { mode = (check.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode; } finally { check.close(); }
  assert.equal(String(mode).toLowerCase(), "wal", "the lock sidecar keeps its configured journal mode");

  const before = await readFile(room.statePath, "utf8");
  await room.updateState(() => { /* no-op */ });
  assert.equal(await readFile(room.statePath, "utf8"), before, "a no-op mutation writes no bytes");
  assert.equal((await room.state()).agentCursors.unknown, undefined);
});

test("state reads a foreign process write instead of a stale cache", async () => {
  const room = await openRoom();
  await room.state();
  const barrier = join(room.workspaceRoot, "foreign-cache-barrier");
  await mkdir(barrier);
  const worker = join(import.meta.dir, "helpers", "room-update-racer.ts");
  const racer = Bun.spawn([process.execPath, worker, room.workspaceRoot, "foreign", barrier]);
  while (!existsSync(join(barrier, "foreign.ready"))) await Bun.sleep(2);
  await writeFile(join(barrier, "release"), "", "utf8");
  assert.equal(await racer.exited, 0);
  assert.equal((await room.state()).agentCursors.foreign, 1);
});

test("SQLite state lock releases after its owner is killed and reports bounded contention", async () => {
  const room = await openRoom();
  const barrier = join(room.workspaceRoot, "lock-barrier");
  await mkdir(barrier);
  const worker = join(import.meta.dir, "helpers", "room-update-racer.ts");
  const lockPath = `${room.statePath}.lock.sqlite`;
  const holder = Bun.spawn([process.execPath, worker, "hold-lock", lockPath, barrier]);
  while (!existsSync(join(barrier, "locked"))) await Bun.sleep(2);

  const original = await readFile(room.statePath, "utf8");
  await assert.rejects(
    withSqliteImmediateLock(lockPath, async () => undefined, { timeoutMs: 40, retryMs: 2 }),
    /SQLite lock contention timed out after 40ms/,
  );
  assert.equal(await readFile(room.statePath, "utf8"), original, "a timed-out contender changes no state bytes");

  holder.kill("SIGKILL");
  await holder.exited;
  await room.updateState((state) => { state.agentCursors.successor = 1; });
  assert.equal((await room.state()).agentCursors.successor, 1);
});

test("an exhausted lock budget runs the callback zero times", async () => {
  const room = await openRoom();
  let runs = 0;
  await assert.rejects(
    withSqliteImmediateLock(`${room.statePath}.lock.sqlite`, async () => { runs++; }, { timeoutMs: 0 }),
    /SQLite lock contention timed out after 0ms/,
  );
  assert.equal(runs, 0, "a caller past its deadline never runs late work");
});

test("a throwing callback releases the lock for the next holder", async () => {
  const room = await openRoom();
  const lockPath = `${room.statePath}.lock.sqlite`;
  await assert.rejects(withSqliteImmediateLock(lockPath, async () => { throw new Error("callback boom"); }), /callback boom/);
  assert.equal(await withSqliteImmediateLock(lockPath, async () => "successor", { timeoutMs: 500 }), "successor");
});

test("lock timeout bounds acquisition only, not an acquired callback", async () => {
  const room = await openRoom();
  const start = Date.now();
  const result = await withSqliteImmediateLock(
    `${room.statePath}.lock.sqlite`,
    async () => {
      await Bun.sleep(30);
      return "completed after budget";
    },
    { timeoutMs: 1 },
  );
  assert.equal(result, "completed after budget");
  assert.ok(Date.now() - start >= 25, "an acquired callback is not cancelled at the acquisition deadline");
});

test("the coordination database stores no rows and the callback runs exactly once", async () => {
  const room = await openRoom();
  const lockPath = `${room.statePath}.lock.sqlite`;
  let runs = 0;
  assert.equal(await withSqliteImmediateLock(lockPath, async () => { runs++; return "once"; }), "once");
  assert.equal(runs, 1, "a successful acquisition never re-runs the callback");
  const db = openSqlite(lockPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master").all();
    assert.deepEqual(tables, [], "the lock sidecar carries no schema and no rows");
  } finally { db.close(); }
});

test("a failed release is not a caller failure and never re-runs the work", async () => {
  const room = await openRoom();
  const lockPath = `${room.statePath}.lock.sqlite`;
  let runs = 0;
  const result = await withSqliteImmediateLock(lockPath, async () => {
    runs++;
    // Yank the coordination file out from under the open transaction: the
    // protected work already happened, so a broken COMMIT must stay invisible.
    await rm(lockPath, { force: true });
    await rm(`${lockPath}-journal`, { force: true });
    return "work done";
  }, { timeoutMs: 200, retryMs: 2 });
  assert.equal(result, "work done");
  assert.equal(runs, 1, "a release anomaly never re-runs non-idempotent work");
});

test("sixteen contenders on one key serialize without a spurious failure", async () => {
  const room = await openRoom();
  const lockPath = `${room.statePath}.lock.sqlite`;
  let inside = 0;
  let peak = 0;
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => withSqliteImmediateLock(lockPath, async () => {
    inside++;
    peak = Math.max(peak, inside);
    await Bun.sleep(1);
    inside--;
    return index;
  }, { timeoutMs: 5_000, retryMs: 2 })));
  assert.deepEqual(results.sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index));
  assert.equal(peak, 1, "holders of one key never overlap");
});

test("a transcript-only room gains state without touching the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-rooms-"));
  const transcriptPath = workspacePaths.transcript(root, "legacy");
  await mkdir(join(transcriptPath, ".."), { recursive: true });
  const line = `${JSON.stringify({ id: "e1", author: "user", text: "hi", ts: "1" })}\n`;
  await writeFile(transcriptPath, line, "utf8");

  const opened = await RoomHandle.open(root, "legacy");
  assert.deepEqual(await opened.state(), normalizeRoomState(undefined));
  assert.equal(await readFile(opened.transcriptPath, "utf8"), line, "seeding state never rewrites an existing transcript");
});

test("malformed existing state rejects without replacing recoverable bytes", async () => {
  const room = await openRoom();
  const corrupt = "{not valid JSON\n";
  await writeFile(room.statePath, corrupt, "utf8");
  await assert.rejects(room.state(), SyntaxError);
  await assert.rejects(room.updateState((state) => { state.agentCursors.never = 1; }), SyntaxError);
  assert.equal(await readFile(room.statePath, "utf8"), corrupt);
});

test("persisted malformed trust and privacy bits reject without rewriting bytes", async () => {
  for (const bit of ["summonUntrusted", "incognito"] as const) {
    const room = await openRoom();
    const bytes = JSON.stringify({ activeRoles: {}, agentCursors: {}, [bit]: "yes" });
    await writeFile(room.statePath, bytes, "utf8");
    await assert.rejects(room.state(), new RegExp(`invalid persisted ${bit} bit`));
    assert.equal(await readFile(room.statePath, "utf8"), bytes);
  }
  for (const invalid of ["null", "[]", "42"]) {
    const room = await openRoom();
    await writeFile(room.statePath, invalid, "utf8");
    await assert.rejects(room.state(), /invalid persisted room state/);
  }
  // The input normalizer's compatibility contract remains lenient.
  assert.equal(normalizeRoomState({ summonUntrusted: "yes", incognito: "yes" }).summonUntrusted, undefined);
  assert.equal(normalizeRoomState({ summonUntrusted: "yes", incognito: "yes" }).incognito, undefined);
});

test("state updates preserve future metadata and no-op bytes", async () => {
  const room = await openRoom();
  const raw = {
    activeRoles: {},
    thinkingOverrides: {},
    agentCursors: {},
    runtimeDetails: {},
    queue: [{
      taskId: "future-task",
      text: "queued",
      targets: ["gaia"],
      queuedAt: "1",
      futureCustody: { generation: 2 },
      attachments: [{ name: "proof.txt", mime: "text/plain", size: 5, path: "/proof.txt", futureAttachment: true }],
    }],
    futureRoot: { nested: [1, 2, 3] },
  };
  const originalBytes = `${JSON.stringify(raw, null, 4)}\n`;
  await writeFile(room.statePath, originalBytes, "utf8");
  room.invalidate();

  await room.updateState(() => {});
  assert.equal(await readFile(room.statePath, "utf8"), originalBytes, "a no-op mutation never rewrites established bytes");

  const peer = await RoomHandle.open(room.workspaceRoot, room.roomId);
  await Promise.all([
    room.updateState((state) => { state.activeRoles.gaia = "plan"; }),
    peer.updateState((state) => { state.thinkingOverrides.gaia = "high"; }),
  ]);

  const persisted = JSON.parse(await readFile(room.statePath, "utf8")) as typeof raw & {
    activeRoles: { gaia: string };
    thinkingOverrides: { gaia: string };
  };
  assert.equal(persisted.activeRoles.gaia, "plan");
  assert.equal(persisted.thinkingOverrides.gaia, "high");
  assert.deepEqual(persisted.futureRoot, raw.futureRoot);
  assert.deepEqual(persisted.queue[0].futureCustody, raw.queue[0].futureCustody);
  assert.equal(persisted.queue[0].attachments[0].futureAttachment, true);
  assert.equal((await room.state()).thinkingOverrides.gaia, "high", "peer writes invalidate this handle's cache");
});

test("setup activation applies its delta over current room state and invalidates peer caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-setup-room-"));
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(root, "home");
  try {
    await initWorkspace(root);
    const workspace = await loadWorkspace(root);
    const room = await RoomHandle.open(root, "default");
    const raw = {
      activeRoles: {},
      thinkingOverrides: {},
      agentCursors: { runner: 7 },
      runtimeDetails: {},
      futureRoot: { protocol: 2 },
    };
    await writeFile(room.statePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    room.invalidate();
    await room.state(); // cache the pre-setup document in a live room handle

    await activateSetup(workspace, "monad", "default");

    const persisted = JSON.parse(await readFile(room.statePath, "utf8")) as typeof raw & { monad?: unknown };
    assert.deepEqual(persisted.futureRoot, raw.futureRoot, "setup delta retains unknown root fields");
    assert.equal(persisted.agentCursors.runner, 7, "setup delta retains concurrent runtime progress");
    assert.ok(persisted.monad, "setup delta adds the monad block");
    assert.ok((await room.state()).monad, "setup write invalidates a peer handle's stale cache");
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
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

test("normalizeRoomState: pet bindings are per-agent, optional, and safely validated", () => {
  const state = normalizeRoomState({
    activeRoles: {},
    agentCursors: {},
    petBindings: { gaia: "gaia", terry: "nari", escape: "../bad", "bad/agent": "gaia", blank: "" },
  });
  assert.deepEqual(state.petBindings, { gaia: "gaia", terry: "nari" });
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, petBindings: {} }).petBindings, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, petBindings: "gaia" }).petBindings, undefined);
});

test("normalizeRoomState: incognito flag survives the whitelist (only literal true)", () => {
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, incognito: true }).incognito, true);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, incognito: "yes" }).incognito, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).incognito, undefined);
});

test("normalizeRoomState: humans allowlist survives the whitelist, dedupes, and empty never persists", () => {
  const withHumans = normalizeRoomState({ activeRoles: {}, agentCursors: {}, humans: ["u_a", "u_b", "u_a"] });
  assert.deepEqual(withHumans.humans, ["u_a", "u_b"]);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, humans: [] }).humans, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {}, humans: [1, null, "", "  "] }).humans, undefined);
  assert.equal(normalizeRoomState({ activeRoles: {}, agentCursors: {} }).humans, undefined);
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

// seedTranscript is exclusive-create: a fork/import landing on an id that
// already has history must REFUSE, and say so through its return value — a
// caller that ignores the false silently drops the snapshot it thought it
// copied.
test("seedTranscript refuses an occupied room and never clobbers its history", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-rooms-seed-"));
  const room = await RoomHandle.open(root, "target");
  await room.addUserMessage("original history", []);
  const before = await readFile(workspacePaths.transcript(root, "target"), "utf8");

  assert.equal(await room.seedTranscript('{"id":"intruder","author":"user","text":"nope","timestamp":"t"}\n'), false);
  assert.equal(await readFile(workspacePaths.transcript(root, "target"), "utf8"), before, "an occupied transcript was rewritten");

  const empty = await RoomHandle.open(root, "fresh");
  assert.equal(await empty.seedTranscript(before), true, "a free id is seeded");
  assert.equal((await empty.eventsFrom(0)).events[0]!.text, "original history");
  await rm(root, { recursive: true, force: true });
});
