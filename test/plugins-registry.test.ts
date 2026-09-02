import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityBroker } from "../src/services/capabilities/index.js";
import {
  PluginRegistry,
  type PluginRegister,
} from "../src/services/plugins/registry.js";

async function pluginPackage(root: string, directory: string, id: string, version = "1.0.0"): Promise<void> {
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
      contributes: { commands: [], tools: [], channels: [], providers: [] },
    })),
  ]);
}

function registered(dispose?: () => void): { register: PluginRegister } {
  return { register: () => dispose ? { dispose } : {} };
}

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
    assert.deepEqual(disposed, ["acme.alpha"]);
    assert.equal(registry.current.plugins[0]?.id, "acme.alpha");

    failBeta = false;
    const staged = await registry.stageReload();
    assert.equal(staged.status, "staged");
    await registry.applyTurnBoundary();
    assert.deepEqual(disposed, ["acme.alpha", "acme.alpha"]);
    await registry.shutdown();
    await registry.shutdown();
    assert.deepEqual(disposed, ["acme.alpha", "acme.alpha", "acme.beta", "acme.alpha"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
