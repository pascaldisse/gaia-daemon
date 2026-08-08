import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openRoomLifecycle } from "../src/workspace/room-lifecycle.ts";
import { openRoomStore, type RoomStore } from "../src/room/store.ts";
import { createTempDir } from "./helpers/temp.ts";

async function makeRoom(roomsDir: string, id: string, state?: string): Promise<void> {
  await mkdir(join(roomsDir, id), { recursive: true });
  if (state !== undefined) await writeFile(join(roomsDir, id, "state.json"), state, "utf8");
}

test("lifecycle skips files and symlinks, orders ids, and tolerates malformed state", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    await makeRoom(roomsDir, "z-room");
    await makeRoom(roomsDir, "a-room", "{ not json");
    await writeFile(join(roomsDir, "stray.txt"), "not a room", "utf8");
    await symlink(join(roomsDir, "z-room"), join(roomsDir, "linked-room"));

    const lifecycle = openRoomLifecycle(roomsDir);
    assert.deepEqual(await lifecycle.list(), [
      { id: "a-room", path: join(roomsDir, "a-room") },
      { id: "z-room", path: join(roomsDir, "z-room") },
    ]);
    assert.deepEqual(await openRoomLifecycle(join(temp.path, "nope")).list(), []);
    assert.deepEqual(await openRoomLifecycle(join(temp.path, "nope")).list("current"), [
      { id: "current", path: join(temp.path, "nope", "current") },
    ]);
  } finally {
    await temp.cleanup();
  }
});

test("lifecycle keeps the room-store path and atomically reserves fork suffixes", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    await makeRoom(roomsDir, "room-a");
    await makeRoom(roomsDir, "room-a-fork");
    await makeRoom(roomsDir, "room-a-fork-2");
    const lifecycle = openRoomLifecycle(roomsDir);

    assert.equal(lifecycle.roomPath("room-a"), openRoomStore(roomsDir, "room-a").dir);
    assert.equal(lifecycle.exists("room-a"), true);
    assert.equal(lifecycle.exists("gone"), false);

    const reservations = await Promise.all(Array.from({ length: 3 }, () => lifecycle.reserveFork("room-a")));
    assert.deepEqual(reservations.map(({ id }) => id).sort(), ["room-a-fork-3", "room-a-fork-4", "room-a-fork-5"]);
  } finally {
    await temp.cleanup();
  }
});

test("lifecycle uses an injected room-store adapter", async () => {
  const opened: string[] = [];
  const fakeStore = (roomId: string): RoomStore => ({
    dir: `fake/${roomId}`,
    transcriptPath: `fake/${roomId}/transcript`,
    statePath: `fake/${roomId}/state`,
    async initialize() {},
    async clearTranscript() {},
    async copyTranscriptTo() {},
    async appendEvent() {},
    async hasEvent() { return false; },
    async recentEvents() { return []; },
    async eventsAfterCursor() { return { events: [], nextCursor: 0 }; },
    async readState() { return { activeRoles: {}, agentCursors: {}, runtimeDetails: {} }; },
    async stateCompatibility() { return { writable: true, unsupportedFields: [] }; },
    async writeState() {},
    async updateState(mutate) {
      const state = { activeRoles: {}, agentCursors: {}, runtimeDetails: {} };
      return (await mutate(state)) ?? state;
    },
  });
  const lifecycle = openRoomLifecycle("ignored", (_roomsDir, roomId) => {
    opened.push(roomId);
    return fakeStore(roomId);
  });

  const openedStore = lifecycle.open("adapter-room");
  assert.equal(openedStore.dir, "fake/adapter-room");
  assert.equal(lifecycle.open("adapter-room"), openedStore);
  assert.equal((await lifecycle.ensure("ensured-room")).dir, "fake/ensured-room");
  assert.deepEqual(opened, ["adapter-room", "ensured-room"]);
});

test("ensure creates the room through the lifecycle and is idempotent", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    const lifecycle = openRoomLifecycle(roomsDir);
    const store = await lifecycle.ensure("lab");
    assert.equal(lifecycle.exists("lab"), true);
    assert.equal(store.dir, join(roomsDir, "lab"));
    await lifecycle.ensure("lab");
    assert.deepEqual(await store.readState(), { activeRoles: {}, agentCursors: {}, runtimeDetails: {} });
  } finally {
    await temp.cleanup();
  }
});
