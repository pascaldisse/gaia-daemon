import test from "node:test";
import assert from "node:assert/strict";
import { scheduleAutoCompactAfterTurn, type ContextUsageProvider } from "../src/services/room/auto-compact.js";

function usage(usedTokens: number, maxTokens: number): ContextUsageProvider {
  return { usageFor: () => ({ usedTokens, maxTokens }) };
}

const config = { thresholdPct: 15, cooldownTurns: 1 } as const;

test("auto-compact does not schedule below its context threshold", () => {
  const result = scheduleAutoCompactAfterTurn(config, undefined, "gaia", usage(149, 1_000));
  assert.equal(result.scheduledPct, undefined);
  assert.equal(result.state.pending, undefined);
});

test("auto-compact schedules an above-threshold next-turn pass", () => {
  const result = scheduleAutoCompactAfterTurn(config, undefined, "gaia", usage(150, 1_000));
  assert.equal(result.scheduledPct, 15);
  assert.deepEqual(result.state.pending, { gaia: 15 });
  assert.deepEqual(result.state.cooldowns, { gaia: 1 });
});

test("auto-compact cooldown suppresses one completed turn before rearming", () => {
  const result = scheduleAutoCompactAfterTurn(config, { cooldowns: { gaia: 1 } }, "gaia", usage(900, 1_000));
  assert.equal(result.scheduledPct, undefined);
  assert.deepEqual(result.state.cooldowns, { gaia: 0 });
});

test("workspace defaults are off and room overrides win", async () => {
  const { parseAutoCompactConfig } = await import("../src/core/config.js");
  const { resolveAutoCompactConfig } = await import("../src/services/room/auto-compact.js");
  assert.deepEqual(parseAutoCompactConfig(undefined), { thresholdPct: null, cooldownTurns: 1 });
  assert.deepEqual(resolveAutoCompactConfig({ thresholdPct: 15, cooldownTurns: 1 }, { thresholdPct: null, cooldownTurns: 3 }), { thresholdPct: null, cooldownTurns: 3 });
});
