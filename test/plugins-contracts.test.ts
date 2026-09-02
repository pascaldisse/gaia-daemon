import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityBroker, CapabilityDeniedError } from "../src/services/capabilities/index.js";
import {
  PluginContributionError,
  invokePluginChannelBridge,
  invokePluginCommand,
  invokePluginProvider,
  invokePluginTool,
  validatePluginContributions,
} from "../src/services/plugins/contracts.js";
import { parseRunnerMessage, type RunnerCommand } from "../src/harness/protocol.js";
import type { PluginContributions } from "../src/services/plugins/manifest.js";

const declared: PluginContributions = Object.freeze({
  commands: Object.freeze(["echo"]),
  tools: Object.freeze(["lookup"]),
  channels: Object.freeze(["telegram"]),
  providers: Object.freeze(["weather"]),
});
const plugin = Object.freeze({ namespace: "acme.echo", requiredCaps: Object.freeze(["room.message"]) });
const context = Object.freeze({ roomId: "room-1", agentId: "agent-1" });
const broker = new CapabilityBroker({
  grantSource: () => ({ agent: ["room.message"] }),
  trustSource: () => true,
});

function contributions() {
  return validatePluginContributions({
    commands: [{ name: "echo", description: "Echoes", run: (_context, request) => ({ reply: request.args.join(" ") }) }],
    tools: [{ name: "lookup", description: "Looks up", execute: () => ({ content: "found" }) }],
    channels: [{ name: "telegram", handle: (_context, request) => ({ handled: request.direction === "incoming", payload: request.payload }) }],
    providers: [{ name: "weather", provide: (_context, request) => ({ output: { operation: request.operation, input: request.input } }) }],
  }, declared);
}

test("typed contribution ports validate declarations and return bounded result shapes", async () => {
  const registered = contributions();
  assert.deepEqual(await invokePluginCommand(broker, plugin, registered, "echo", context, { args: ["one", "two"] }), { reply: "one two" });
  assert.deepEqual(await invokePluginTool(broker, plugin, registered, "lookup", context, { arguments: { query: "x" } }), { content: "found" });
  assert.deepEqual(await invokePluginChannelBridge(broker, plugin, registered, "telegram", context, { direction: "incoming", payload: { body: "hi" } }), { handled: true, payload: { body: "hi" } });
  assert.deepEqual(await invokePluginProvider(broker, plugin, registered, "weather", context, { operation: "forecast", input: "Berlin" }), { output: { operation: "forecast", input: "Berlin" } });
});

test("contribution registration rejects undeclared ports and malformed plugin output", async () => {
  assert.throws(
    () => validatePluginContributions({ commands: [{ name: "other", description: "No", run: () => ({}) }] }, declared),
    PluginContributionError,
  );
  const malformed = validatePluginContributions({
    tools: [{ name: "lookup", description: "Broken", execute: () => ({ content: 4 }) }],
  }, declared);
  await assert.rejects(invokePluginTool(broker, plugin, malformed, "lookup", context, { arguments: {} }), PluginContributionError);
});

test("every contribution call is capability-gated before plugin code runs", async () => {
  let called = false;
  const registered = validatePluginContributions({
    commands: [{ name: "echo", description: "Nope", run: () => { called = true; return { reply: "no" }; } }],
  }, declared);
  const denied = new CapabilityBroker({ grantSource: () => ({}), trustSource: () => true });
  await assert.rejects(invokePluginCommand(denied, plugin, registered, "echo", context, { args: [] }), CapabilityDeniedError);
  assert.equal(called, false);
});

test("runner contribution frames have one typed harness-neutral contract", () => {
  const command: RunnerCommand = {
    type: "plugin-contribution",
    requestId: "req-1",
    pluginId: "acme.echo",
    kind: "tool",
    name: "lookup",
    context,
    payload: { query: "x" },
  };
  assert.equal(command.type, "plugin-contribution");
  assert.deepEqual(
    parseRunnerMessage({ type: "plugin-contribution-result", requestId: "req-1", ok: true, payload: { content: "found" } }),
    { type: "plugin-contribution-result", requestId: "req-1", ok: true, payload: { content: "found" } },
  );
  assert.equal(parseRunnerMessage({ type: "plugin-contribution-result", requestId: "req-1", ok: true, payload: Number.NaN }), undefined);
});
