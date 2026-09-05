import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { CapabilityBroker } from "../src/services/capabilities/broker.js";
import { PluginRegistry } from "../src/services/plugins/registry.js";

const repoRoot = join(import.meta.dirname, "..");
const addonsRoot = join(repoRoot, "addons");

async function telegramRegistry(): Promise<PluginRegistry> {
  const registry = new PluginRegistry({
    pluginsRoot: addonsRoot,
    placement: "daemon",
    capabilityBroker: new CapabilityBroker({ grantSource: () => undefined, trustSource: () => false }),
    importer: (entrypoint) => import(pathToFileURL(entrypoint).href),
  });
  const staged = await registry.stageReload();
  assert.equal(staged.status, "staged");
  assert.equal(await registry.applyTurnBoundary(), true);
  return registry;
}

test("Telegram bridge registers and invokes its typed manifest channel contribution", async () => {
  const registry = await telegramRegistry();
  const context = { roomId: "room", agentId: "telegram-bridge" };
  const incoming = await registry.invokeChannelBridge("gaia.telegram", "telegram", context, {
    direction: "incoming",
    payload: { update_id: 7, message: { chat: { id: 12 }, from: { username: "ada" }, text: "hello" } },
  });
  assert.deepEqual(incoming, { handled: true, payload: { updateId: 7, chatId: 12, fromLabel: "ada", text: "hello" } });
  const offset = await registry.invokeChannelBridge("gaia.telegram", "telegram", context, {
    direction: "incoming",
    payload: { updates: [{ update_id: 4 }, { update_id: 9 }], offset: 3 },
  });
  assert.deepEqual(offset, { handled: true, payload: { offset: 10 } });
  const outgoing = await registry.invokeChannelBridge("gaia.telegram", "telegram", context, {
    direction: "outgoing",
    payload: { event: { author: "agent", text: "x".repeat(4097) }, bridgeUserId: "human" },
  });
  assert.deepEqual(outgoing, { handled: true, payload: { chunks: [`[@agent] ${"x".repeat(4087)}`, "x".repeat(10)] } });
  assert.deepEqual(registry.current.plugins[0]?.contributes.channels, ["telegram"]);
  assert.deepEqual(await registry.invokeChannelBridge("gaia.telegram", "telegram", context, {
    direction: "incoming", payload: { update_id: 8, message: { chat: { id: 12 }, text: "  " } },
  }), { handled: false });
  assert.deepEqual(await registry.invokeChannelBridge("gaia.telegram", "telegram", context, {
    direction: "outgoing", payload: { event: { author: "user", text: "never echo" }, bridgeUserId: "human" },
  }), { handled: false });
  const lineSplit = await registry.invokeChannelBridge("gaia.telegram", "telegram", context, {
    direction: "outgoing", payload: { event: { author: "agent", text: `${"a".repeat(3000)}\n${"b".repeat(2000)}` }, bridgeUserId: "human" },
  });
  assert.deepEqual(lineSplit, { handled: true, payload: { chunks: [`[@agent] ${"a".repeat(3000)}`, "b".repeat(2000)] } });
});

test("Telegram channel preserves parse fallbacks, filters, and lossless splitting", async () => {
  const registry = await telegramRegistry();
  const context = { roomId: "room", agentId: "telegram-bridge" };
  const channel = (direction: "incoming" | "outgoing", payload: Record<string, unknown>) =>
    registry.invokeChannelBridge("gaia.telegram", "telegram", context, { direction, payload });
  assert.deepEqual(await channel("incoming", {
    update_id: 1, message: { chat: { id: 5 }, text: "hi", from: { first_name: "Ada", last_name: "L.", id: 9 } },
  }), { handled: true, payload: { updateId: 1, chatId: 5, text: "hi", fromLabel: "Ada L." } });
  assert.deepEqual(await channel("incoming", {
    update_id: 2, message: { chat: { id: 5 }, text: "hi", from: { id: 99 } },
  }), { handled: true, payload: { updateId: 2, chatId: 5, text: "hi", fromLabel: "99" } });
  for (const payload of [null, {}, { update_id: 1 }, { update_id: 1, message: { chat: { id: 1 } } }, { update_id: "bad", message: {} }]) {
    assert.deepEqual(await channel("incoming", { raw: payload }), { handled: false });
  }
  for (const event of [
    { author: "system", text: "compacted" }, { author: "agent", text: "hi", redacted: true },
    { author: "agent", text: "  " }, { author: "agent", text: "hi", humanId: "bridge" },
  ]) assert.deepEqual(await channel("outgoing", { event, bridgeUserId: "bridge" }), { handled: false });
  assert.deepEqual(await channel("outgoing", { event: { author: "gaia", text: "hi there" }, bridgeUserId: "bridge" }), {
    handled: true, payload: { chunks: ["[@gaia] hi there"] },
  });
  const lineText = Array.from({ length: 100 }, () => "x".repeat(100)).join("\n");
  const lineResult = await channel("outgoing", { event: { author: "agent", text: lineText }, bridgeUserId: "bridge" });
  const lineChunks = (lineResult.payload as { chunks: string[] }).chunks;
  assert.ok(lineChunks.every((chunk) => chunk.length <= 4096));
  assert.equal(lineChunks.join("\n"), `[@agent] ${lineText}`);
  const hardResult = await channel("outgoing", { event: { author: "agent", text: "x".repeat(9000) }, bridgeUserId: "bridge" });
  const hardChunks = (hardResult.payload as { chunks: string[] }).chunks;
  assert.ok(hardChunks.every((chunk) => chunk.length <= 4096));
  assert.equal(hardChunks.join(""), `[@agent] ${"x".repeat(9000)}`);
});

test("Telegram bridge script uses the registered manifest channel, not a service formatter import", async () => {
  const [script, manifest] = await Promise.all([
    readFile(join(repoRoot, "scripts", "telegram-bridge.mjs"), "utf8"),
    readFile(join(addonsRoot, "telegram", "plugin.json"), "utf8"),
  ]);
  assert.match(script, /new PluginRegistry/);
  assert.match(script, /invokeChannelBridge\("gaia\.telegram", "telegram"/);
  assert.doesNotMatch(script, /telegram-bridge-format/);
  assert.match(manifest, /"channels": \["telegram"\]/);
  assert.match(manifest, /"process": "standalone"/);
});
