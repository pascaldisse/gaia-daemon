import assert from "node:assert/strict";
import { test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { newestContentEntryId } from "../src/harness/pi/compaction.js";

test("c4e744e floor excludes the oversized prompt in Pi's rebuilt context", () => {
  const sm = SessionManager.inMemory();
  const bait = sm.appendMessage({ role: "user", content: "BAIT-REGRESSION ".repeat(10000), timestamp: Date.now() });
  const newest = sm.appendMessage({ role: "user", content: "Continue the clean task.", timestamp: Date.now() });
  sm.appendModelChange("test", "test");
  const floor = newestContentEntryId(sm.getEntries() as unknown as Record<string, unknown>[], bait);
  assert.equal(floor, newest);
  sm.appendCompaction("Task → verify clean context.", floor, 40000);
  const context = JSON.stringify(sm.buildSessionContext());
  assert.ok(!context.includes("BAIT-REGRESSION"));
  assert.ok(context.includes("Continue the clean task."));
});
