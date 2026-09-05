import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CapabilityBroker } from "../src/services/capabilities/index.js";
import { loadCommandPlugins } from "../src/services/plugins.js";
import { importPluginModule, pluginModuleUrl } from "../src/services/plugins/loader.js";
import { readPluginManifest } from "../src/services/plugins/manifest.js";
import {
  PluginRegistry,
  type PluginRegister,
  type PluginRegistryEvent,
} from "../src/services/plugins/registry.js";

async function pluginPackage(root: string, directory: string, id: string, version = "1.0.0", commands: readonly string[] = []): Promise<void> {
  const packageRoot = join(root, directory);
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "index.mjs"), "export {}\n"),
    writeFile(join(packageRoot, "plugin.json"), JSON.stringify({
      id,
      version,
      engine: "gaia-daemon@^2.0.0",
      placement: "daemon",
      requiredCaps: [],
      contributes: { commands, tools: [], channels: [], providers: [] },
    })),
  ]);
}

function registered(dispose?: () => void): { register: PluginRegister } {
  return { register: () => dispose ? { dispose } : {} };
}

test("room command adapter invokes the daemon-owned registry", async () => {
  const calls: unknown[][] = [];
  const plugins = await loadCommandPlugins({
    commandContributions: () => [{ pluginId: "acme.echo", name: "echo", description: "Echo" }],
    async invokeCommand(...args) {
      calls.push(args);
      return { reply: "ok" };
    },
  });
  const plugin = plugins.get("echo");
  assert.ok(plugin);
  assert.deepEqual(
    await plugin.run(["hello"], {
      homedir: "/home/test", workspaceId: "workspace-1", roomId: "room-1", agentId: "agent-1", workspaceRoot: "/workspace", agents: [],
    }),
    { reply: "ok" },
  );
  assert.deepEqual(calls, [["acme.echo", "echo", { workspaceId: "workspace-1", roomId: "room-1", agentId: "agent-1" }, { args: ["hello"], pluginContext: { homedir: "/home/test", workspaceId: "workspace-1", roomId: "room-1", agentId: "agent-1", workspaceRoot: "/workspace", agents: [] } }]]);
});

test("registry validates and invokes typed contributions through its capability broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  try {
    await pluginPackage(root, "echo", "acme.echo");
    await writeFile(join(root, "echo", "plugin.json"), JSON.stringify({
      id: "acme.echo",
      version: "1.0.0",
      engine: "gaia-daemon@^2.0.0",
      placement: "daemon",
      requiredCaps: ["room.message"],
      contributes: { commands: ["echo"], tools: [], channels: [], providers: [] },
    }));
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      capabilityBroker: new CapabilityBroker({ grantSource: () => ({ agent: ["room.message"] }), trustSource: () => true }),
      importer: async () => ({
        register: () => ({
          contributions: {
            commands: [{ name: "echo", description: "Echo", run: (_context, request) => ({ reply: request.args.join(" ") }) }],
          },
        }),
      }),
    });
    const staged = await registry.stageReload();
    assert.equal(staged.status, "staged");
    await registry.applyTurnBoundary();
    assert.deepEqual(registry.current.plugins[0]?.contributes.commands, ["echo"]);
    assert.deepEqual(
      await registry.invokeCommand("acme.echo", "echo", { roomId: "room-1", agentId: "agent-1" }, { args: ["hi"] }),
      { reply: "hi" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("contribution invocation holds a generation lease until async plugin code settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  try {
    await pluginPackage(root, "echo", "acme.echo");
    await writeFile(join(root, "echo", "plugin.json"), JSON.stringify({
      id: "acme.echo", version: "1.0.0", engine: "gaia-daemon@^2.0.0", placement: "daemon", requiredCaps: [],
      contributes: { commands: ["echo"], tools: [], channels: [], providers: [] },
    }));
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      capabilityBroker: new CapabilityBroker({ grantSource: () => ({}), trustSource: () => true }),
      importer: async () => ({
        register: () => ({
          contributions: {
            commands: [{ name: "echo", description: "Async", run: () => new Promise((resolve) => {
              release = () => resolve({ reply: "done" });
              markStarted?.();
            }) }],
          },
        }),
      }),
    });
    await registry.stageReload();
    await registry.applyTurnBoundary();
    const pending = registry.invokeCommand("acme.echo", "echo", { roomId: "room-1", agentId: "agent-1" }, { args: [] });
    await started;
    await registry.stageReload();
    assert.equal(await registry.applyTurnBoundary(), false);
    release?.();
    assert.deepEqual(await pending, { reply: "done" });
    assert.equal(await registry.applyTurnBoundary(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("stages a candidate while a turn holds one immutable generation, then swaps at its boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  const disposed: string[] = [];
  try {
    await pluginPackage(root, "echo", "acme.echo", "1.0.0");
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      importer: async (_path, plugin) => registered(() => { disposed.push(`${plugin.manifest.id}@${plugin.manifest.version}`); }),
    });
    const initial = await registry.stageReload();
    assert.equal(initial.status, "staged");
    assert.equal(await registry.applyTurnBoundary(), true);
    const lease = registry.beginTurn();
    assert.equal(lease.generation.generation, 1);
    assert.equal(lease.generation.plugins[0]?.version, "1.0.0");

    await pluginPackage(root, "echo", "acme.echo", "2.0.0");
    const staged = await registry.stageReload();
    assert.equal(staged.status, "staged");
    assert.equal(registry.current.plugins[0]?.version, "1.0.0");
    assert.equal(await registry.applyTurnBoundary(), false);
    assert.equal(lease.generation.plugins[0]?.version, "1.0.0");

    lease.end();
    assert.equal(await registry.applyTurnBoundary(), true);
    assert.equal(registry.current.plugins[0]?.version, "2.0.0");
    assert.deepEqual(disposed, ["acme.echo@1.0.0"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages replacement after an in-flight command, swaps the next invocation, and reports ordered lifecycle events", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  const events: PluginRegistryEvent[] = [];
  const disposed: string[] = [];
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  try {
    await pluginPackage(root, "echo", "acme.echo", "1.0.0", ["echo"]);
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      capabilityBroker: new CapabilityBroker({ grantSource: () => ({}), trustSource: () => true }),
      importer: async (_path, plugin) => ({
        register: () => ({
          contributions: {
            commands: [{
              name: "echo",
              description: "Echo",
              run: (_context, request) => plugin.manifest.version === "1.0.0"
                ? new Promise((resolve) => {
                  release = () => resolve({ reply: `1.0.0:${request.args.join(" ")}` });
                  markStarted?.();
                })
                : { reply: `${plugin.manifest.version}:${request.args.join(" ")}` },
            }],
          },
          dispose: () => { disposed.push(`${plugin.manifest.id}@${plugin.manifest.version}`); },
        }),
      }),
      onEvent: (event) => events.push(event),
    });
    await registry.stageReload();
    await registry.applyTurnBoundary();
    const oldTurn = registry.invokeCommand("acme.echo", "echo", { roomId: "room-1", agentId: "agent-1" }, { args: ["inflight"] });
    await started;
    await pluginPackage(root, "echo", "acme.echo", "2.0.0", ["echo"]);
    await registry.stageReload();
    assert.equal(await registry.applyTurnBoundary(), false);
    release?.();
    assert.deepEqual(await oldTurn, { reply: "1.0.0:inflight" });
    assert.equal(await registry.applyTurnBoundary(), true);
    assert.deepEqual(
      await registry.invokeCommand("acme.echo", "echo", { roomId: "room-1", agentId: "agent-1" }, { args: ["next"] }),
      { reply: "2.0.0:next" },
    );
    assert.deepEqual(disposed, ["acme.echo@1.0.0"]);
    assert.deepEqual(events, [
      { kind: "staged", generation: 1, pluginIds: ["acme.echo"] },
      { kind: "swapped", generation: 1, previousGeneration: 0, pluginIds: ["acme.echo"] },
      { kind: "staged", generation: 2, pluginIds: ["acme.echo"] },
      { kind: "swapped", generation: 2, previousGeneration: 1, pluginIds: ["acme.echo"] },
      { kind: "disposed", generation: 1, pluginId: "acme.echo" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed manifest validation or import leaves the active generation intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  let imports = 0;
  try {
    await pluginPackage(root, "echo", "acme.echo");
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      importer: async () => {
        imports += 1;
        return registered();
      },
    });
    await registry.stageReload();
    await registry.applyTurnBoundary();
    const active = registry.current;

    await writeFile(join(root, "echo", "plugin.json"), JSON.stringify({ placement: "invalid" }));
    const invalid = await registry.stageReload();
    assert.equal(invalid.status, "failed");
    assert.equal(registry.current, active);
    assert.equal(registry.staged, undefined);
    assert.equal(imports, 1);

    await pluginPackage(root, "echo", "acme.echo");
    let importFails = false;
    const failing = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      importer: async () => {
        if (importFails) throw new Error("import exploded");
        return registered();
      },
    });
    await failing.stageReload();
    await failing.applyTurnBoundary();
    const prior = failing.current;
    importFails = true;
    await writeFile(join(root, "echo", "index.mjs"), "export {}\n// changed\n");
    const failed = await failing.stageReload();
    assert.equal(failed.status, "failed");
    assert.equal(failing.current, prior);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposes staged failures, replaced generations, and shutdown generations exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  const disposed: string[] = [];
  let failBeta = false;
  try {
    await pluginPackage(root, "alpha", "acme.alpha");
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      importer: async (_path, plugin) => {
        if (plugin.manifest.id === "acme.beta" && failBeta) return { register: () => { throw new Error("register exploded"); } };
        return registered(() => { disposed.push(plugin.manifest.id); });
      },
    });
    await registry.stageReload();
    await registry.applyTurnBoundary();

    await pluginPackage(root, "beta", "acme.beta");
    failBeta = true;
    const failed = await registry.stageReload();
    assert.equal(failed.status, "failed");
    assert.deepEqual(disposed, []);
    assert.equal(registry.current.plugins[0]?.id, "acme.alpha");

    failBeta = false;
    const staged = await registry.stageReload();
    assert.equal(staged.status, "staged");
    await registry.applyTurnBoundary();
    assert.deepEqual(disposed, []);
    await registry.shutdown();
    await registry.shutdown();
    assert.deepEqual(disposed, ["acme.beta", "acme.alpha"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("room command adapter preserves every legacy command result field", async () => {
  const plugins = await loadCommandPlugins({
    commandContributions: () => [{ pluginId: "acme.full", name: "full", description: "Full" }],
    async invokeCommand() {
      return {
        reply: "reply", steer: "steer", activeAgent: "agent", state: { saved: true }, rewriteAsMessage: true, targets: ["agent"],
        panel: () => ({ title: "panel" }), prompt: () => "prompt", renderCap: () => ({ maxLines: 1 }), turnStart: () => ({ started: true }),
      };
    },
  });
  const plugin = plugins.get("full");
  assert.ok(plugin);
  const context = { homedir: "/home/test", workspaceId: "workspace", roomId: "room", agentId: "agent", workspaceRoot: "/workspace", agents: [] };
  const result = await plugin.run([], context);
  assert.deepEqual(result.state, { saved: true });
  assert.equal(result.activeAgent, "agent");
  assert.equal(result.rewriteAsMessage, true);
  assert.deepEqual(result.targets, ["agent"]);
  assert.equal(typeof plugin.panel, "function");
  assert.equal(typeof plugin.prompt, "function");
  assert.equal(typeof plugin.renderCap, "function");
  assert.equal(typeof plugin.turnStart, "function");
});

test("entrypoint replacement stages fresh module code at the same path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  const entrypoint = join(root, "probe", "index.mjs");
  try {
    await pluginPackage(root, "probe", "acme.probe", "1.0.0", ["probe"]);
    await writeFile(entrypoint, `
export function register(context) {
  return { contributions: { commands: [{ name: "probe", description: "Probe", run: () => ({ reply: "v1:" + context.generation }) }] } };
}
`);
    const manifest = await readPluginManifest(join(root, "probe", "plugin.json"), { pluginsRoot: root });
    assert.match(pluginModuleUrl(manifest), /\?gaia-gen=[a-f0-9]{64}$/);
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      capabilityBroker: new CapabilityBroker({ grantSource: () => ({}), trustSource: () => true }),
      importer: (_path, plugin) => importPluginModule(plugin),
    });
    const first = await registry.stageReload();
    if (first.status === "failed") throw new Error(first.reason);
    assert.equal(await registry.applyTurnBoundary(), true);
    await writeFile(entrypoint, `
export function register(context) {
  return { contributions: { commands: [{ name: "probe", description: "Probe", run: () => ({ reply: "v2:" + context.generation }) }] } };
}
`);
    await registry.stageReload();
    assert.equal(await registry.applyTurnBoundary(), true);
    assert.deepEqual(
      await registry.invokeCommand("acme.probe", "probe", { roomId: "room-1", agentId: "agent-1" }, { args: [] }),
      { reply: "v2:2" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged entrypoints carry forward without re-import or disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-registry-"));
  let imports = 0;
  const digests: string[] = [];
  let disposals = 0;
  try {
    await pluginPackage(root, "echo", "acme.echo");
    const registry = new PluginRegistry({
      pluginsRoot: root,
      placement: "daemon",
      importer: async (_path, plugin) => {
        imports += 1;
        digests.push(plugin.entrypointDigest);
        return registered(() => { disposals += 1; });
      },
    });
    await registry.stageReload();
    assert.equal(await registry.applyTurnBoundary(), true);
    await registry.stageReload();
    assert.equal(await registry.applyTurnBoundary(), true);
    assert.equal(imports, 1, digests.join(","));
    assert.equal(disposals, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
