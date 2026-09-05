import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONTEXT_DIET_POLICY,
  mergeContextDietPolicy,
  parseContextDietOverrides,
  parseContextDietPolicy,
} from "../src/domain/context-diet.js";
import { ContextPolicyStore } from "../src/services/context-policy-store.js";

test("DEFAULT_CONTEXT_DIET_POLICY: preset is OFF (IRON)", () => {
  assert.equal(DEFAULT_CONTEXT_DIET_POLICY.preset, false);
});

test("parseContextDietPolicy: missing/malformed fields fall back field-by-field, never throws", () => {
  assert.deepEqual(parseContextDietPolicy(undefined), DEFAULT_CONTEXT_DIET_POLICY);
  assert.deepEqual(parseContextDietPolicy(null), DEFAULT_CONTEXT_DIET_POLICY);
  assert.deepEqual(parseContextDietPolicy("garbage"), DEFAULT_CONTEXT_DIET_POLICY);
  const parsed = parseContextDietPolicy({ preset: true, fullTurnWindow: 3, toolTailLines: -5, keepAllToolCalls: "nope" });
  assert.equal(parsed.preset, true);
  assert.equal(parsed.fullTurnWindow, 3);
  assert.equal(parsed.toolTailLines, DEFAULT_CONTEXT_DIET_POLICY.toolTailLines); // -5 rejected (min 1)
  assert.equal(parsed.keepAllToolCalls, DEFAULT_CONTEXT_DIET_POLICY.keepAllToolCalls); // wrong type rejected
});

test("parseContextDietOverrides: only well-typed present fields survive", () => {
  assert.deepEqual(parseContextDietOverrides({ preset: true, junk: "x" }), { preset: true });
  assert.deepEqual(parseContextDietOverrides({ fullTurnWindow: -1 }), {});
  assert.deepEqual(parseContextDietOverrides({}), {});
});

test("mergeContextDietPolicy: overrides win field-by-field, base fills the rest", () => {
  const merged = mergeContextDietPolicy(DEFAULT_CONTEXT_DIET_POLICY, { preset: true, toolTailLines: 5 });
  assert.equal(merged.preset, true);
  assert.equal(merged.toolTailLines, 5);
  assert.equal(merged.fullTurnWindow, DEFAULT_CONTEXT_DIET_POLICY.fullTurnWindow);
});

test("ContextPolicyStore: default OFF with no files on disk", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "gaia-diet-store-"));
  const store = new ContextPolicyStore(rootDir);
  assert.deepEqual(await store.workspace(), DEFAULT_CONTEXT_DIET_POLICY);
  assert.deepEqual(await store.effective("room-1"), DEFAULT_CONTEXT_DIET_POLICY);
});

test("ContextPolicyStore: room override wins over workspace default; clearRoom reverts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "gaia-diet-store-"));
  const store = new ContextPolicyStore(rootDir);
  await store.patchWorkspace({ preset: false, toolTailLines: 10 });
  const roomEffective = await store.patchRoom("room-1", { preset: true });
  assert.equal(roomEffective.preset, true);
  assert.equal(roomEffective.toolTailLines, 10); // inherited from workspace default
  // A different room is untouched.
  assert.equal((await store.effective("room-2")).preset, false);
  const cleared = await store.clearRoom("room-1");
  assert.equal(cleared.preset, false);
});

test("ContextPolicyStore: patchRoom is a partial merge, not a replace", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "gaia-diet-store-"));
  const store = new ContextPolicyStore(rootDir);
  await store.patchRoom("room-1", { preset: true, fullTurnWindow: 2 });
  const second = await store.patchRoom("room-1", { toolTailLines: 4 });
  assert.equal(second.preset, true);
  assert.equal(second.fullTurnWindow, 2);
  assert.equal(second.toolTailLines, 4);
});
