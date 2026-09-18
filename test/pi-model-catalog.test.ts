import { test } from "bun:test";
import assert from "node:assert/strict";
import { reasoningFor } from "../src/harness/spec.js";
import "../src/harness/pi.js";

// Whip 427 regression: a snapshot resolves reasoning capability ONCE PER AGENT
// (30 agents in the gaia-love workspace). Rebuilding the pi model catalog per
// call (ModelRuntime.create, ~18ms of disk + provider composition) was the whole
// ~0.7s room-selection floor. The catalog is a pure read stamped by
// ~/.pi/agent/models.json, so repeat resolution must not pay for it again.
test("pi model catalog is built once per catalog version, not once per lookup", async () => {
  const model = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;
  // First call may build the catalog; it is the repeats a snapshot multiplies.
  await reasoningFor("pi", model);

  const started = performance.now();
  const repeats = 30;
  for (let i = 0; i < repeats; i++) await reasoningFor("pi", model);
  const perCall = (performance.now() - started) / repeats;

  // A rebuild per call costs ~18ms each; a memo hit is microseconds. 2ms leaves
  // an order of magnitude of slack on either side of that gap.
  assert.ok(perCall < 2, `reasoningFor averaged ${perCall.toFixed(2)}ms per call — catalog is being rebuilt`);
});
