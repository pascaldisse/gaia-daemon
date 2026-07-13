import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiEvent, UsageLimits, UsageProbeResult } from "../src/core/types.js";
import { emailFromJwt, mapAnthropicUsage, mapChatGptUsage } from "../src/harness/usage.js";
import { reduceAccountProbes, UsageService } from "../src/services/usage-service.js";

const usage = (account: string, percent: number, fetchedAt = "2026-07-09T09:00:00.000Z"): UsageLimits => ({
  account,
  plan: "max",
  windows: [{ kind: "session", label: "Current session", percent, severity: "normal" }],
  fetchedAt,
});

test("reduceAccountProbes: ok sets", () => {
  const next = usage("anthropic", 28);
  assert.deepEqual(reduceAccountProbes(undefined, [{ status: "ok", usage: next }]), { set: next });
});

test("emailFromJwt extracts only a display email claim", () => {
  const payload = Buffer.from(JSON.stringify({ email: "person@example.com" })).toString("base64url");
  assert.equal(emailFromJwt(`header.${payload}.signature`), "person@example.com");
  assert.equal(emailFromJwt("not-a-jwt"), undefined);
});

test("reduceAccountProbes: all-none clears when prev exists", () => {
  assert.deepEqual(reduceAccountProbes(usage("anthropic", 46), [{ status: "none" }, { status: "none" }]), { clear: true });
});

test("reduceAccountProbes: all-none no-ops without prev", () => {
  assert.deepEqual(reduceAccountProbes(undefined, [{ status: "none" }, { status: "none" }]), {});
});

test("reduceAccountProbes: error keeps cached usage without set or clear", () => {
  assert.deepEqual(reduceAccountProbes(usage("anthropic", 46), [{ status: "error" }]), {});
});

test("reduceAccountProbes: cooldownMs is max retryAfterMs across errors", () => {
  assert.deepEqual(
    reduceAccountProbes(usage("anthropic", 46), [{ status: "error", retryAfterMs: 15_000 }, { status: "error", retryAfterMs: 60_000 }]),
    { cooldownMs: 60_000 },
  );
});

test("reduceAccountProbes: error without retryAfterMs asks for no cooldown", () => {
  assert.deepEqual(reduceAccountProbes(usage("anthropic", 46), [{ status: "error" }]), {});
});

test("UsageService persists account usage across restart and broadcasts every ok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-usage-"));
  const cachePath = join(dir, "usage.json");
  const broadcasts: UiEvent[] = [];
  let probeIndex = 0;
  const snapshots = [usage("anthropic", 28, "2026-07-09T09:00:00.000Z"), usage("anthropic", 28, "2026-07-09T09:01:00.000Z")];
  const serviceA = new UsageService({
    cachePath,
    broadcast: (event) => broadcasts.push(event),
    probes: () =>
      new Map<string, Array<() => Promise<UsageProbeResult>>>([
        ["anthropic", [async () => ({ status: "ok", usage: snapshots[Math.min(probeIndex++, snapshots.length - 1)] })]],
      ]),
  });

  await serviceA.refresh({ force: true });
  await serviceA.refresh({ force: true });

  assert.equal(broadcasts.length, 2, "fresh ok snapshots broadcast even when visible numbers are unchanged");
  assert.deepEqual(broadcasts.map((event) => (event.type === "usage-limits" ? event.usage?.fetchedAt : undefined)), [
    "2026-07-09T09:00:00.000Z",
    "2026-07-09T09:01:00.000Z",
  ]);

  const serviceB = new UsageService({
    cachePath,
    broadcast: () => assert.fail("unreachable provider should not broadcast or clear cached usage"),
    probes: () => new Map<string, Array<() => Promise<UsageProbeResult>>>([["anthropic", [async () => ({ status: "error" })]]]),
  });
  await serviceB.load();
  assert.deepEqual(serviceB.currentUsage(), [{ type: "usage-limits", account: "anthropic", usage: snapshots[1] }]);
  await serviceB.refresh({ force: true });
  assert.deepEqual(serviceB.currentUsage(), [{ type: "usage-limits", account: "anthropic", usage: snapshots[1] }]);
});

test("UsageService evicts a no-longer-declared account from its durable snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-usage-"));
  const cachePath = join(dir, "usage.json");
  const broadcasts: UiEvent[] = [];
  const service = new UsageService({
    cachePath,
    broadcast: (event) => broadcasts.push(event),
    probes: () => new Map([["current", [async () => ({ status: "ok" as const, usage: usage("provider-name", 12) })]]]),
  });
  await service.refresh({ force: true });
  const stale = new UsageService({ cachePath, broadcast: (event) => broadcasts.push(event), probes: () => new Map() });
  await stale.load();
  await stale.refresh({ force: true });
  assert.deepEqual(stale.snapshot(), {});
  assert.ok(broadcasts.some((event) => event.type === "usage-limits" && event.account === "current" && event.usage === null));
});

test("mapAnthropicUsage maps windows in order, clamps percent, and derives severity", () => {
  const mapped = mapAnthropicUsage(
    {
      limits: [
        { kind: "weekly_scoped", percent: 130, scope: { model: { display_name: "Fable" } }, resets_at: "2026-07-16T09:00:00.000Z" },
        { kind: "weekly_all", percent: 85 },
        { kind: "session", percent: 96 },
      ],
    },
    "max",
  );

  assert.ok(mapped);
  assert.equal(mapped.account, "anthropic");
  assert.equal(mapped.plan, "max");
  assert.deepEqual(mapped.windows.map((win) => win.kind), ["session", "weekly_all", "weekly_scoped"]);
  assert.deepEqual(mapped.windows.map((win) => win.label), ["Current session", "Weekly · all models", "Weekly · Fable"]);
  assert.deepEqual(mapped.windows.map((win) => win.percent), [96, 85, 100]);
  assert.deepEqual(mapped.windows.map((win) => win.severity), ["critical", "warning", "critical"]);
  assert.equal(mapped.windows[2].model, "Fable");
  assert.equal(mapped.windows[2].resetsAt, "2026-07-16T09:00:00.000Z");
  assert.match(mapped.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("mapAnthropicUsage returns null when no usage windows are present", () => {
  assert.equal(mapAnthropicUsage({ limits: [{ kind: "other", percent: 25 }] }), null);
  assert.equal(mapAnthropicUsage({}), null);
});

test("mapChatGptUsage maps primary and secondary windows", () => {
  const mapped = mapChatGptUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_788_851_400 },
      secondary_window: { used_percent: 81, limit_window_seconds: 604_800, reset_at: 1_789_456_600 },
    },
  });

  assert.ok(mapped);
  assert.equal(mapped.account, "openai");
  assert.equal(mapped.plan, "plus");
  assert.deepEqual(mapped.windows.map((win) => win.kind), ["session", "weekly_all"]);
  assert.deepEqual(mapped.windows.map((win) => win.label), ["Current session (5h)", "Weekly · all models"]);
  assert.deepEqual(mapped.windows.map((win) => win.percent), [12, 81]);
  assert.deepEqual(mapped.windows.map((win) => win.severity), ["normal", "warning"]);
  assert.equal(mapped.windows[0].resetsAt, new Date(1_788_851_400 * 1000).toISOString());
  assert.equal(mapped.windows[1].resetsAt, new Date(1_789_456_600 * 1000).toISOString());
  assert.match(mapped.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("mapChatGptUsage returns null when no usage windows are present", () => {
  assert.equal(mapChatGptUsage({ rate_limit: { primary_window: null, secondary_window: null } }), null);
  assert.equal(mapChatGptUsage({}), null);
});
