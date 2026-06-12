import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendRoomEvent, newRoomEventId, readRoomEventsAfterCursor } from "../src/room/transcript.ts";
import { createTempDir } from "./helpers/temp.ts";

test("room event cursor returns only events after the previous line count", async () => {
  const temp = await createTempDir();
  try {
    const path = join(temp.path, "transcript.jsonl");
    await appendRoomEvent(path, { id: newRoomEventId(), timestamp: "1", author: "user", targets: ["gaia"], text: "one" });

    const first = await readRoomEventsAfterCursor(path, 0);
    assert.deepEqual(first.events.map((event) => event.text), ["one"]);
    assert.equal(first.nextCursor, 1);

    await appendRoomEvent(path, { id: newRoomEventId(), timestamp: "2", author: "gaia", text: "two" });
    await appendRoomEvent(path, { id: newRoomEventId(), timestamp: "3", author: "user", targets: ["gaia"], text: "three" });

    const second = await readRoomEventsAfterCursor(path, first.nextCursor);
    assert.deepEqual(second.events.map((event) => event.text), ["two", "three"]);
    assert.equal(second.nextCursor, 3);

    const third = await readRoomEventsAfterCursor(path, second.nextCursor);
    assert.deepEqual(third.events, []);
    assert.equal(third.nextCursor, 3);
  } finally {
    await temp.cleanup();
  }
});

test("events keep their ids and legacy lines get stable line-based ids", async () => {
  const temp = await createTempDir();
  try {
    const path = join(temp.path, "transcript.jsonl");
    await mkdir(dirname(path), { recursive: true });
    // A transcript line written before events carried ids.
    await appendFile(path, `${JSON.stringify({ timestamp: "1", author: "user", targets: ["gaia"], text: "old" })}\n`, "utf8");
    await appendRoomEvent(path, { id: "evt_fixed", timestamp: "2", author: "gaia", text: "new" });

    const firstRead = await readRoomEventsAfterCursor(path, 0);
    const secondRead = await readRoomEventsAfterCursor(path, 0);

    assert.equal(firstRead.events[0].id, "legacy_0");
    assert.equal(firstRead.events[1].id, "evt_fixed");
    assert.deepEqual(firstRead.events.map((event) => event.id), secondRead.events.map((event) => event.id));
  } finally {
    await temp.cleanup();
  }
});
