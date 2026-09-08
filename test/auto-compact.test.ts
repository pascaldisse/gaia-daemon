import { test } from "bun:test";
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

test("workspace defaults are 180k and room overrides win", async () => {
  const { parseAutoCompactConfig } = await import("../src/core/config.js");
  const { resolveAutoCompactConfig } = await import("../src/services/room/auto-compact.js");
  assert.deepEqual(parseAutoCompactConfig(undefined), { thresholdPct: null, thresholdTokens: 180_000, cooldownTurns: 1 });
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
      workspace: { agents: {}, config: { autoCompact: { thresholdPct: 15, cooldownTurns: 1 } } },
      runtimes: {},
      roomDefaultTarget: async () => "gaia",
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


const tokensConfig = { thresholdPct: null, thresholdTokens: 180_000, cooldownTurns: 1 } as const;

for (const capacity of [200_000, 1_000_000]) {
  for (const used of [179_999, 180_000, 180_001]) {
    test(`absolute threshold: ${used} used / ${capacity} capacity`, () => {
      const result = scheduleAutoCompactAfterTurn(tokensConfig, undefined, "gaia", usage(used, capacity));
      assert.equal(result.scheduledTokens, used >= 180_000 ? used : undefined);
      assert.equal(result.state.pending?.gaia !== undefined, used >= 180_000);
    });
  }
}

test("token scheduling needs no capacity; invalid usage cannot schedule", () => {
  const ready = scheduleAutoCompactAfterTurn(tokensConfig, undefined, "gaia", { usageFor: () => ({ usedTokens: 180_000 }) });
  assert.equal(ready.scheduledTokens, 180_000);
  assert.equal(ready.state.pending?.gaia, 0);
  for (const usedTokens of [NaN, Infinity, -1]) {
    assert.equal(scheduleAutoCompactAfterTurn(tokensConfig, undefined, "gaia", { usageFor: () => ({ usedTokens }) }).scheduledPct, undefined);
  }
});

test("absolute policy leaves smaller capacity untouched, rather than faking a smaller window", () => {
  const nativeUsage = { usedTokens: 120_000, maxTokens: 128_000 };
  const result = scheduleAutoCompactAfterTurn(tokensConfig, undefined, "gaia", { usageFor: () => nativeUsage });
  assert.equal(result.scheduledPct, undefined);
  assert.deepEqual(nativeUsage, { usedTokens: 120_000, maxTokens: 128_000 });
});

test("token mode retains per-agent durable pending state, cooldown, and override", async () => {
  const { takePendingAutoCompact } = await import("../src/services/room/auto-compact.js");
  const previous = { thresholdTokens: 180_000, cooldowns: { other: 2 }, pending: { other: 70 } };
  const result = scheduleAutoCompactAfterTurn(tokensConfig, previous, "gaia", usage(180_000, 200_000));
  assert.equal(result.state.thresholdTokens, 180_000);
  assert.deepEqual(result.state.pending, { other: 70, gaia: 90 });
  assert.deepEqual(previous, { thresholdTokens: 180_000, cooldowns: { other: 2 }, pending: { other: 70 } });
  const taken = takePendingAutoCompact(result.state, "gaia");
  assert.equal(taken.pct, 90);
  assert.equal(taken.state.thresholdTokens, 180_000);
  assert.deepEqual(taken.state.pending, { other: 70 });
  assert.equal(scheduleAutoCompactAfterTurn(tokensConfig, taken.state, "gaia", usage(190_000, 200_000)).scheduledTokens, undefined);
});

test("config validation + atomic threshold modes + explicit off inheritance", async () => {
  const { parseAutoCompactConfig } = await import("../src/core/config.js");
  for (const thresholdTokens of [0, -1, 1.5, NaN, Infinity, "180k", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parseAutoCompactConfig({ thresholdTokens }), tokensConfig);
  }
  assert.deepEqual(parseAutoCompactConfig({ thresholdPct: 20 }, tokensConfig), configWithPct(20));
  assert.deepEqual(parseAutoCompactConfig({ thresholdPct: null }, tokensConfig), configWithPct(null));
  assert.deepEqual(parseAutoCompactConfig({ thresholdTokens: null }, tokensConfig), { ...configWithPct(null), thresholdTokens: null });
  assert.deepEqual(parseAutoCompactConfig({ thresholdPct: 20, thresholdTokens: 180_000 }), tokensConfig);
  assert.deepEqual(parseAutoCompactConfig({ cooldownTurns: 3 }, tokensConfig), { ...tokensConfig, cooldownTurns: 3 });
});

function configWithPct(thresholdPct: number | null) { return { thresholdPct, cooldownTurns: 1 }; }

test("exact model policies merge, switch modes, preserve cooldown, then yield to room", async () => {
  const { parseAutoCompactConfig } = await import("../src/core/config.js");
  const { resolveAutoCompactConfig } = await import("../src/services/room/auto-compact.js");
  const global = parseAutoCompactConfig({ modelOverrides: { provider: { model: { thresholdTokens: 150_000, cooldownTurns: 3 } } } });
  const workspace = parseAutoCompactConfig({ modelOverrides: { provider: { model: { thresholdPct: 75 }, other: { thresholdTokens: null } } } }, global);
  assert.deepEqual(workspace.modelOverrides?.provider?.model, { thresholdPct: 75, cooldownTurns: 3 });
  const effective = resolveAutoCompactConfig(workspace, undefined, { provider: "provider", model: "model" });
  assert.equal(effective.thresholdPct, 75);
  assert.equal(effective.thresholdTokens, undefined);
  assert.equal(effective.cooldownTurns, 3);
  assert.equal(resolveAutoCompactConfig(workspace, undefined, { provider: "Provider", model: "model" }).thresholdTokens, 180_000);
  assert.equal(resolveAutoCompactConfig(workspace, undefined, { provider: "provider", model: "model-suffix" }).thresholdTokens, 180_000);
  assert.equal(resolveAutoCompactConfig(workspace, undefined, { provider: "provider", model: "other" }).thresholdPct, null);
  assert.equal(resolveAutoCompactConfig(workspace, undefined, { provider: "provider", model: "other" }).thresholdTokens, null);
  const room = resolveAutoCompactConfig(workspace, { thresholdTokens: 90_000 }, { provider: "provider", model: "model" });
  assert.equal(room.thresholdTokens, 90_000);
  assert.equal(room.thresholdPct, null);
  assert.equal(room.cooldownTurns, 3);
  const off = resolveAutoCompactConfig(workspace, { thresholdPct: null }, { provider: "provider", model: "model" });
  assert.equal(off.thresholdPct, null);
  assert.equal(off.thresholdTokens, undefined);
});

test("model policy keys are literal, including prototype-shaped provider/model ids", async () => {
  const { parseAutoCompactConfig } = await import("../src/core/config.js");
  const { resolveAutoCompactConfig } = await import("../src/services/room/auto-compact.js");
  const parsed = parseAutoCompactConfig(JSON.parse('{"modelOverrides":{"__proto__":{"constructor":{"thresholdPct":45}}}}'));
  assert.equal(resolveAutoCompactConfig(parsed, undefined, { provider: "__proto__", model: "constructor" }).thresholdPct, 45);
  assert.equal(resolveAutoCompactConfig(parsed, undefined, { provider: "toString", model: "constructor" }).thresholdTokens, 180_000);
});

test("token commands persist/reopen, switch modes, clear pending, and reject invalid input", async () => {
  assert.deepEqual(parseCommand("/autocompact 180k 2"), { type: "autocompact", value: "180k", cooldownTurns: "2" });
  assert.deepEqual(parseCommand("/autocompact 180000 tokens 2"), { type: "autocompact", value: "180000 tokens", cooldownTurns: "2" });
  const temp = await createTempDir();
  try {
    const room = await RoomHandle.open(temp.path, "default");
    const command = RoomCommandsMixin.prototype.runAutoCompactCommand.bind({ room, workspace: { agents: {}, config: { autoCompact: tokensConfig } }, runtimes: {}, roomDefaultTarget: async () => "gaia", emitSnapshot: async () => {} });
    assert.match(await command("180k", "2"), /180000 tokens; cooldown 2 turns/);
    assert.deepEqual((await (await RoomHandle.open(temp.path, "default")).state()).autoCompact, { thresholdPct: null, thresholdTokens: 180_000, cooldownTurns: 2 });
    await room.updateState(state => { state.autoCompact!.pending = { gaia: 90 }; state.autoCompact!.cooldowns = { gaia: 1 }; });
    assert.match(await command("20"), /Auto-compact: 20%/);
    assert.deepEqual((await room.state()).autoCompact, { thresholdPct: 20, cooldownTurns: 2 });
    assert.match(await command("180000 tokens"), /Auto-compact: 180000 tokens/);
    for (const invalid of ["0k", "-1k", "180000", "180000 token", "Infinityk", "9007199254740992 tokens"]) assert.match(await command(invalid), /^Usage:/);
    const extra = parseCommand("/autocompact 180k 2 junk");
    assert.equal(extra.type, "autocompact");
    if (extra.type === "autocompact") assert.match(await command(extra.value, extra.cooldownTurns), /^Usage:/);
    assert.match(await command("off"), /Auto-compact: off/);
    assert.deepEqual((await (await RoomHandle.open(temp.path, "default")).state()).autoCompact, { thresholdPct: null, cooldownTurns: 2 });
  } finally { await temp.cleanup(); }
});


test("model identity fallback requires exact configured pair; runtime change wins immediately", async () => {
  const { autoCompactModelFor } = await import("../src/services/room/auto-compact.js");
  const configured = { provider: "provider", name: "configured" };
  assert.deepEqual(autoCompactModelFor(undefined, configured), { provider: "provider", model: "configured" });
  assert.equal(autoCompactModelFor(undefined, { name: "configured" }), undefined);
  assert.equal(autoCompactModelFor(undefined, { provider: "provider" }), undefined);
  const runtime = { effectiveModel: { provider: "other", model: "live/id" } } as import("../src/harness/spec.js").AgentRuntime;
  assert.deepEqual(autoCompactModelFor(runtime, configured), { provider: "other", model: "live/id" });
});
