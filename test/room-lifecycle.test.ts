import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openRoomDirectory } from "../src/workspace/room-lifecycle.ts";
import { openRoomStore } from "../src/room/store.ts";
import { createTempDir } from "./helpers/temp.ts";

async function makeRoom(roomsDir: string, id: string, state?: string): Promise<void> {
  await mkdir(join(roomsDir, id), { recursive: true });
  if (state !== undefined) await writeFile(join(roomsDir, id, "state.json"), state, "utf8");
}

test("listRoomIds skips stray files and returns [] for a missing rooms dir", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    await makeRoom(roomsDir, "a-room");
    await makeRoom(roomsDir, "b-room");
    await writeFile(join(roomsDir, "stray.txt"), "not a room", "utf8");

    const ids = await openRoomDirectory(roomsDir).listRoomIds();
    assert.deepEqual([...ids].sort(), ["a-room", "b-room"]);
    assert.deepEqual(await openRoomDirectory(join(temp.path, "nope")).listRoomIds(), []);
  } finally {
    await temp.cleanup();
  }
});

test("a room with malformed state still opens, normalized to defaults", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    await makeRoom(roomsDir, "broken", "{ not json");
    const directory = openRoomDirectory(roomsDir);

    assert.deepEqual(await directory.open("broken").readState(), {
      activeRoles: {},
      agentCursors: {},
      runtimeDetails: {},
    });
  } finally {
    await temp.cleanup();
  }
});

test("roomPath/exists follow the room store layout, and fork ids chain past collisions", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    const directory = openRoomDirectory(roomsDir);
    await makeRoom(roomsDir, "room-a");

    assert.equal(directory.roomPath("room-a"), openRoomStore(roomsDir, "room-a").dir);
    assert.equal(directory.exists("room-a"), true);
    assert.equal(directory.exists("gone"), false);

    assert.equal(directory.nextForkId("room-a"), "room-a-fork");
    await makeRoom(roomsDir, "room-a-fork");
    assert.equal(directory.nextForkId("room-a"), "room-a-fork-2");
    await makeRoom(roomsDir, "room-a-fork-2");
    assert.equal(directory.nextForkId("room-a"), "room-a-fork-3");
  } finally {
    await temp.cleanup();
  }
});
