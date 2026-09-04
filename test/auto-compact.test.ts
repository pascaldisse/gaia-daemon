import test from "node:test";
import assert from "node:assert/strict";
import { scheduleAutoCompactAfterTurn, type ContextUsageProvider } from "../src/services/room/auto-compact.js";
import { parseCommand, SLASH_COMMANDS } from "../src/services/commands.js";
import { RoomHandle } from "../src/domain/rooms.js";
import { RoomCommandsMixin } from "../src/services/room/commands-facade.js";
import { createTempDir } from "./helpers/temp.js";

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

test("/autocompact parses, persists its room override, and shows the effective setting", async () => {
  assert.ok(SLASH_COMMANDS.some((command) => command.name === "autocompact"), "autocomplete exposes /autocompact");
  assert.deepEqual(parseCommand("/autocompact 20 2"), { type: "autocompact", value: "20", cooldownTurns: "2" });
  assert.deepEqual(parseCommand("/autocompact off"), { type: "autocompact", value: "off", cooldownTurns: undefined });
  const temp = await createTempDir();
  try {
    const room = await RoomHandle.open(temp.path, "default");
    const command = RoomCommandsMixin.prototype.runAutoCompactCommand.bind({
      room,
      workspace: { config: { autoCompact: { thresholdPct: 15, cooldownTurns: 1 } } },
      emitSnapshot: async () => {},
    });
    assert.match(await command(), /Auto-compact: 15%; cooldown 1 turn \(threshold: workspace, cooldown: workspace\)/);
    assert.match(await command("20", "2"), /Auto-compact: 20%; cooldown 2 turns \(threshold: room, cooldown: room\)/);
    assert.deepEqual((await room.state()).autoCompact, { thresholdPct: 20, cooldownTurns: 2 });
    assert.match(await command("off"), /Auto-compact: off; cooldown 2 turns \(threshold: room, cooldown: room\)/);
  } finally {
    await temp.cleanup();
  }
});
