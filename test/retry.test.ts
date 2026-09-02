import test from "node:test";
import assert from "node:assert/strict";
import { sleep } from "../src/core/retry.js";

test("sleep resolves asynchronously", async () => {
  let settled = false;
  const waiting = sleep(0).then(() => { settled = true; });
  assert.equal(settled, false);
  await waiting;
  assert.equal(settled, true);
});
