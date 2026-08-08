import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openRoomStore } from "../src/room/store.ts";
import { createTempDir } from "./helpers/temp.ts";

test("v1 room store opens existing history without rewriting it", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    const roomDir = join(roomsDir, "old-room");
    const statePath = join(roomDir, "state.json");
    const transcriptPath = join(roomDir, "transcript.jsonl");
    const stateBytes = `${JSON.stringify({ activeRoles: { gaia: "plan" }, agentCursors: { gaia: 1 }, runtimeDetails: {} }, null, 4)}\n`;
    const transcriptBytes = `${JSON.stringify({ timestamp: "1", author: "user", targets: ["gaia"], text: "old history" })}\n`;
    await mkdir(roomDir, { recursive: true });
    await writeFile(statePath, stateBytes, "utf8");
    await writeFile(transcriptPath, transcriptBytes, "utf8");

    const store = openRoomStore(roomsDir, "old-room");
    assert.deepEqual(await store.readState(), {
      activeRoles: { gaia: "plan" },
      agentCursors: { gaia: 1 },
      runtimeDetails: {},
    });
    assert.deepEqual((await store.eventsAfterCursor(0)).events.map((event) => [event.id, event.text]), [["legacy_0", "old history"]]);

    assert.equal(await readFile(statePath, "utf8"), stateBytes);
    assert.equal(await readFile(transcriptPath, "utf8"), transcriptBytes);
  } finally {
    await temp.cleanup();
  }
});

test("copyTranscriptTo keeps transcript layout behind the room-store boundary", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    const source = openRoomStore(roomsDir, "source");
    const destination = openRoomStore(roomsDir, "destination");
    await source.appendEvent({ id: "evt_1", timestamp: "1", author: "gaia", text: "hello" });

    await source.copyTranscriptTo(destination);

    assert.deepEqual(await destination.recentEvents(10), [{
      id: "evt_1",
      timestamp: "1",
      author: "gaia",
      text: "hello",
    }]);
  } finally {
    await temp.cleanup();
  }
});

test("room store initializes missing files without rewriting established bytes", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, "rooms");
    const store = openRoomStore(roomsDir, "room-a");

    await store.initialize();
    assert.equal(await readFile(store.transcriptPath, "utf8"), "");
    assert.deepEqual(JSON.parse(await readFile(store.statePath, "utf8")), {
      activeRoles: {}, agentCursors: {}, runtimeDetails: {},
    });

    await writeFile(store.transcriptPath, "history\n", "utf8");
    await writeFile(store.statePath, '{"preserved":true}\n', "utf8");
    await store.initialize();
    assert.equal(await readFile(store.transcriptPath, "utf8"), "history\n");
    assert.equal(await readFile(store.statePath, "utf8"), '{"preserved":true}\n');
  } finally {
    await temp.cleanup();
  }
});

test("openRoomStore keeps the established v1 state and transcript paths", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    const store = openRoomStore(roomsDir, "room-a");

    assert.equal(store.statePath, join(roomsDir, "room-a", "state.json"));
    assert.equal(store.transcriptPath, join(roomsDir, "room-a", "transcript.jsonl"));

    const state = { activeRoles: { gaia: "plan" }, agentCursors: { gaia: 4 }, runtimeDetails: {} };
    await store.writeState(state);
    assert.deepEqual(await store.readState(), state);
    await store.appendEvent({ id: "evt_1", timestamp: "1", author: "gaia", text: "hello" });

    assert.deepEqual(JSON.parse(await readFile(store.statePath, "utf8")), state);
    assert.deepEqual(JSON.parse((await readFile(store.transcriptPath, "utf8")).trim()), {
      id: "evt_1",
      timestamp: "1",
      author: "gaia",
      text: "hello",
    });
  } finally {
    await temp.cleanup();
  }
});

test("initialize creates default room files and never touches existing bytes", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, "deep", "nested", ".gaia", "rooms");
    const store = openRoomStore(roomsDir, "fresh");
    await store.initialize();
    assert.equal(await readFile(store.transcriptPath, "utf8"), "");
    assert.equal(
      await readFile(store.statePath, "utf8"),
      `${JSON.stringify({ activeRoles: {}, agentCursors: {}, runtimeDetails: {} }, null, 2)}\n`,
    );

    const stateBytes = `${JSON.stringify({ activeRoles: { gaia: "plan" }, agentCursors: {}, runtimeDetails: {} }, null, 4)}\n`;
    const transcriptBytes = `${JSON.stringify({ timestamp: "1", author: "user", targets: [], text: "keep" })}\n`;
    await writeFile(store.statePath, stateBytes, "utf8");
    await writeFile(store.transcriptPath, transcriptBytes, "utf8");
    await store.initialize();
    assert.equal(await readFile(store.statePath, "utf8"), stateBytes);
    assert.equal(await readFile(store.transcriptPath, "utf8"), transcriptBytes);
  } finally {
    await temp.cleanup();
  }
});

test("initialize repairs a partially existing room and survives concurrency", async () => {
  const temp = await createTempDir();
  try {
    const roomsDir = join(temp.path, ".gaia", "rooms");
    const store = openRoomStore(roomsDir, "partial");
    await mkdir(store.dir, { recursive: true });
    const transcriptBytes = `${JSON.stringify({ timestamp: "1", author: "user", targets: [], text: "half" })}\n`;
    await writeFile(store.transcriptPath, transcriptBytes, "utf8");

    await Promise.all(Array.from({ length: 8 }, () => openRoomStore(roomsDir, "partial").initialize()));
    assert.equal(await readFile(store.transcriptPath, "utf8"), transcriptBytes);
    assert.deepEqual(await store.readState(), { activeRoles: {}, agentCursors: {}, runtimeDetails: {} });
  } finally {
    await temp.cleanup();
  }
});
