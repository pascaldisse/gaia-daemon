// Circuit breaker state machine, driven by an injected clock: trip after N
// consecutive failures, fast-fail during the cooldown, half-open probe, close on
// a clean launch, reopen with a longer cooldown if the probe fails, and reset
// after an idle window.

import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../src/harness/breaker.js";

function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const CONFIG = { threshold: 3, cooldownScheduleMs: [10_000, 30_000], resetMs: 60 * 60_000 };

test("stays closed until the failure threshold, then trips open and fast-fails", () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CONFIG, now: c.now });
  const KEY = "pi:deepseek/x";

  assert.equal(b.canAttempt(KEY).allowed, true);
  b.onFailure(KEY); // 1
  b.onFailure(KEY); // 2
  assert.equal(b.snapshot(KEY).state, "closed");
  assert.equal(b.canAttempt(KEY).allowed, true); // still under threshold
  b.onFailure(KEY); // 3 → trip

  const decision = b.canAttempt(KEY);
  assert.equal(decision.allowed, false);
  assert.equal(b.snapshot(KEY).state, "open");
  assert.equal(decision.retryInMs, 10_000); // first cooldown
});

test("a clean launch before the threshold clears accumulated failures", () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CONFIG, now: c.now });
  const KEY = "pi:deepseek/x";
  b.onFailure(KEY);
  b.onFailure(KEY);
  b.onSuccess(KEY); // healthy launch resets the streak
  assert.equal(b.snapshot(KEY).failures, 0);
  b.onFailure(KEY); // back to 1, not 3
  assert.equal(b.canAttempt(KEY).allowed, true);
});

test("half-opens for one probe after cooldown; success closes it", () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CONFIG, now: c.now });
  const KEY = "pi:deepseek/x";
  b.onFailure(KEY);
  b.onFailure(KEY);
  b.onFailure(KEY); // open

  c.advance(9_999);
  assert.equal(b.canAttempt(KEY).allowed, false); // still cooling

  c.advance(1); // cooldown elapsed
  const probe = b.canAttempt(KEY);
  assert.equal(probe.allowed, true);
  assert.equal(b.snapshot(KEY).state, "half-open");

  b.onSuccess(KEY);
  assert.equal(b.snapshot(KEY).state, "closed");
  assert.equal(b.snapshot(KEY).trips, 0);
});

test("a failed probe reopens with the next, longer cooldown", () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CONFIG, now: c.now });
  const KEY = "pi:deepseek/x";
  b.onFailure(KEY);
  b.onFailure(KEY);
  b.onFailure(KEY); // open, trips=1

  c.advance(10_000);
  assert.equal(b.canAttempt(KEY).allowed, true); // half-open probe
  b.onFailure(KEY); // probe failed → reopen, trips=2
  assert.equal(b.snapshot(KEY).state, "open");
  assert.equal(b.snapshot(KEY).trips, 2);

  c.advance(10_000); // first cooldown would have elapsed...
  assert.equal(b.canAttempt(KEY).allowed, false); // ...but the second is 30s
  c.advance(20_000);
  assert.equal(b.canAttempt(KEY).allowed, true);
});

test("an idle target past the reset window starts fresh", () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CONFIG, now: c.now });
  const KEY = "pi:deepseek/x";
  b.onFailure(KEY);
  b.onFailure(KEY);
  b.onFailure(KEY); // open
  assert.equal(b.snapshot(KEY).state, "open");

  c.advance(60 * 60_000 + 1); // longer than resetMs since last event
  assert.equal(b.canAttempt(KEY).allowed, true);
  assert.equal(b.snapshot(KEY).state, "closed");
  assert.equal(b.snapshot(KEY).trips, 0);
});

test("breakers are independent per target key", () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CONFIG, now: c.now });
  b.onFailure("pi:deepseek/x");
  b.onFailure("pi:deepseek/x");
  b.onFailure("pi:deepseek/x"); // trip x only
  assert.equal(b.canAttempt("pi:deepseek/x").allowed, false);
  assert.equal(b.canAttempt("claude:anthropic/y").allowed, true);
});
