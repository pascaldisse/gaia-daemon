// INSIGHT "full" tier (decree 2026-07-28 part 3): pull-based raw read of any
// currently-incognito room, and (bare-fallback scope note) ledger search.
// Exercises localRecallSearch's ghoulRoom/ghoulLedgers directly \u2014 the same
// gate logic the daemon-bridge path (daemon.ts harnessGhoulRoomRead /
// harnessGhoulLedgerSearch) runs server-side, without standing up a full
// GaiaDaemon (heavy: registry, bus, scheduler, embed sidecar \u2014 out of scope
// for a unit test of the gate + windowing logic itself).

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRecallSearch } from "../src/harness/tools-pi.js";
import { RoomHandle, newRoomEventId } from "../src/domain/rooms.js";
import { ensureWorkspaceRoom } from "../src/domain/workspace.js";
import { workspacePaths } from "../src/core/paths.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gaia-insight-recall-"));
}

async function agentEvent(handle: RoomHandle, author: string, text: string): Promise<void> {
  await handle.appendEvent({ id: newRoomEventId(), timestamp: new Date().toISOString(), author, text });
}

test("ghoulRoom: insight 'full' reads an incognito room's raw transcript; any other tier is denied", async () => {
  const root = await makeRoot();
  const ghoulRoomId = "ghoul-sonnet-abc123";
  await ensureWorkspaceRoom(root, ghoulRoomId, { incognito: true });
  const handle = await RoomHandle.open(root, ghoulRoomId);
  await agentEvent(handle, "ghoul-sonnet", "scouted the ruins, found nothing");
  await agentEvent(handle, "ghoul-sonnet", "second pass: a real customer email surfaced here — the kind of thing that must never enter the shared index");

  const callerRoomDir = workspacePaths.roomDir(root, "solas-home");

  const full = localRecallSearch(callerRoomDir, "solas-home", { id: "solas", memoryDir: "/tmp/x-solas/memory", insight: "full" });
  assert.ok(full.ghoulRoom, "ghoulRoom is wired for the bare fallback");
  const text = await full.ghoulRoom!(ghoulRoomId);
  assert.match(text, /scouted the ruins/);
  assert.match(text, /real customer email surfaced here/);
  assert.match(text, /ghoul-sonnet:/);

  for (const insight of [undefined, "line" as const]) {
    const denied = localRecallSearch(callerRoomDir, "solas-home", { id: "watcher", memoryDir: "/tmp/x-watcher/memory", insight });
    await assert.rejects(denied.ghoulRoom!(ghoulRoomId), /insight "full" required/);
  }
});

test("ghoulRoom: refuses a room that is NOT incognito \u2014 even for a full-insight caller (read it through normal recall instead)", async () => {
  const root = await makeRoot();
  const normalRoomId = "default";
  await ensureWorkspaceRoom(root, normalRoomId); // no incognito
  const callerRoomDir = workspacePaths.roomDir(root, normalRoomId);
  const full = localRecallSearch(callerRoomDir, normalRoomId, { id: "solas", memoryDir: "/tmp/x-solas/memory", insight: "full" });
  await assert.rejects(full.ghoulRoom!(normalRoomId), /is not an incognito room/);
});

test("ghoulRoom: unknown room id fails loudly, not silently empty", async () => {
  const root = await makeRoot();
  await ensureWorkspaceRoom(root, "default");
  const callerRoomDir = workspacePaths.roomDir(root, "default");
  const full = localRecallSearch(callerRoomDir, "default", { id: "solas", memoryDir: "/tmp/x-solas/memory", insight: "full" });
  await assert.rejects(full.ghoulRoom!("no-such-room-ever"), /no such room/);
});

test("ghoulRoom: windowed by offset/limit \u2014 a room with many events pages instead of dumping everything", async () => {
  const root = await makeRoot();
  const ghoulRoomId = "ghoul-terra-xyz789";
  await ensureWorkspaceRoom(root, ghoulRoomId, { incognito: true });
  const handle = await RoomHandle.open(root, ghoulRoomId);
  for (let i = 0; i < 50; i++) await agentEvent(handle, "ghoul-terra", `event number ${i}`);

  const callerRoomDir = workspacePaths.roomDir(root, "solas-home");
  const full = localRecallSearch(callerRoomDir, "solas-home", { id: "solas", memoryDir: "/tmp/x-solas/memory", insight: "full" });

  const firstWindow = await full.ghoulRoom!(ghoulRoomId, { limit: 10 });
  assert.match(firstWindow, /event number 0\b/);
  assert.match(firstWindow, /event number 9\b/);
  assert.doesNotMatch(firstWindow, /event number 10\b/);
  assert.match(firstWindow, /50 events total/);
  assert.match(firstWindow, /40 more events; pass offset=10 to continue/);

  const secondWindow = await full.ghoulRoom!(ghoulRoomId, { offset: 10, limit: 10 });
  assert.match(secondWindow, /event number 10\b/);
  assert.doesNotMatch(secondWindow, /event number 9\b/);
});

test("ghoulLedgers: bare/no-daemon fallback declines honestly instead of half-implementing cross-agent search", async () => {
  const root = await makeRoot();
  await ensureWorkspaceRoom(root, "default");
  const callerRoomDir = workspacePaths.roomDir(root, "default");
  const full = localRecallSearch(callerRoomDir, "default", { id: "solas", memoryDir: "/tmp/x-solas/memory", insight: "full" });
  assert.ok(full.ghoulLedgers, "ghoulLedgers is present (denies at call time, not absent from the surface)");
  await assert.rejects(full.ghoulLedgers!(), /requires the daemon bridge/);
});

test("ghoulRoom: an unknown room id creates NO phantom room on disk (RoomHandle.open's create-on-open side effect must never fire for a bad id)", async () => {
  const { existsSync } = await import("node:fs");
  const root = await makeRoot();
  await ensureWorkspaceRoom(root, "default");
  const callerRoomDir = workspacePaths.roomDir(root, "default");
  const full = localRecallSearch(callerRoomDir, "default", { id: "solas", memoryDir: "/tmp/x-solas/memory", insight: "full" });
  await assert.rejects(full.ghoulRoom!("totally-made-up-room-id"));
  assert.equal(existsSync(join(root, ".gaia", "rooms", "totally-made-up-room-id")), false, "no phantom room directory was created");
});
