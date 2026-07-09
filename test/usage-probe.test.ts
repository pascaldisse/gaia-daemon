import test from "node:test";
import assert from "node:assert/strict";
import { reduceUsageProbe } from "../src/daemon.js";
import type { UsageLimits } from "../src/core/types.js";

const limits = (percent: number): UsageLimits => ({
  harness: "claude",
  plan: "max",
  windows: [{ kind: "session", label: "Current session", percent, severity: "normal" }],
  fetchedAt: "2026-07-09T09:00:00Z",
});

test("ok result caches and broadcasts a first value", () => {
  const d = reduceUsageProbe(undefined, { status: "ok", usage: limits(28) });
  assert.deepEqual(d.set, limits(28));
  assert.deepEqual(d.broadcast, limits(28));
  assert.equal(d.clear, undefined);
});

test("ok result caches but does NOT re-broadcast an unchanged value", () => {
  const prev = limits(28);
  const d = reduceUsageProbe(prev, { status: "ok", usage: limits(28) });
  assert.ok(d.set, "still refreshes the cache");
  assert.equal(d.broadcast, undefined, "no redundant broadcast when nothing UI-visible changed");
});

test("a TRANSIENT error keeps the last-known value — never blanks a healthy chip", () => {
  const prev = limits(46);
  const d = reduceUsageProbe(prev, { status: "error", retryAfterMs: 60_000 });
  assert.equal(d.set, undefined, "cache is left untouched");
  assert.equal(d.clear, undefined, "the chip is NOT cleared on a 429/blip");
  assert.equal(d.broadcast, undefined, "no broadcast — the old value stands");
  assert.equal(d.cooldownMs, 60_000, "surfaces the backoff so the daemon stops hammering");
});

test("error without a backoff hint still keeps the value and asks for no cooldown", () => {
  const d = reduceUsageProbe(limits(46), { status: "error" });
  assert.equal(d.set, undefined);
  assert.equal(d.clear, undefined);
  assert.equal(d.cooldownMs, undefined);
});

test("an AUTHORITATIVE none clears a previously-shown chip", () => {
  const d = reduceUsageProbe(limits(46), { status: "none" });
  assert.equal(d.clear, true);
  assert.equal(d.broadcast, null, "broadcast null tells clients to drop the chip");
  assert.equal(d.set, undefined);
});

test("none with nothing cached is a no-op (no spurious clear broadcast)", () => {
  const d = reduceUsageProbe(undefined, { status: "none" });
  assert.deepEqual(d, {});
});
