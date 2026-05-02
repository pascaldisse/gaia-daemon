import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendRoomEvent, readRoomEventsAfterCursor } from "../src/room/transcript.ts";
import { createTempDir } from "./helpers/temp.ts";

test("room event cursor returns only events after the previous line count", async () => {
  const temp = await createTempDir();
  try {
    const path = join(temp.path, "transcript.jsonl");
    await appendRoomEvent(path, { timestamp: "1", author: "user", targets: ["gaia"], text: "one" });

    const first = await readRoomEventsAfterCursor(path, 0);
    assert.deepEqual(first.events.map((event) => event.text), ["one"]);
    assert.equal(first.nextCursor, 1);

    await appendRoomEvent(path, { timestamp: "2", author: "gaia", text: "two" });
    await appendRoomEvent(path, { timestamp: "3", author: "user", targets: ["gaia"], text: "three" });

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
