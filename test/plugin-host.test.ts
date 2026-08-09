import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, PluginHostError, type PluginHostEvent } from "../src/services/plugin-host.js";
import type { BundledPluginInventoryItem } from "../src/services/bundled-plugins.js";
import type { ValidatedPluginManifest } from "../src/services/plugin-manifest.js";

function manifest(name: string, permissions: readonly string[] = [], requiredCaps: readonly string[] = []): ValidatedPluginManifest {
  const packageRoot = `/bundle/addons/${name}`;
  return Object.freeze({
    manifestPath: `${packageRoot}/plugin.json`,
    packageRoot,
    entrypointPath: `${packageRoot}/index.mjs`,
    manifest: Object.freeze({
      schema: 1 as const,
      name,
      version: "1.0.0",
      engine: "gaia-daemon@^1.0.0",
      entrypoint: "index.mjs",
      permissions: Object.freeze([...permissions]),
      requiredCaps: Object.freeze([...requiredCaps]),
    }),
    engineCompatibility: Object.freeze({ compatible: true }),
    order: 0,
  });
}

function compatible(name: string, permissions?: readonly string[], requiredCaps?: readonly string[]): BundledPluginInventoryItem {
  return Object.freeze({
    status: "compatible" as const,
    namespace: `bundled:${name}`,
    plugin: manifest(name, permissions, requiredCaps),
  });
}

function unavailable(name: string, reason = "incompatible daemon engine"): BundledPluginInventoryItem {
  return Object.freeze({ status: "unavailable" as const, namespace: `bundled:${name}`, reason, plugin: manifest(name) });
}

function invalid(manifestPath: string, reason = "plugin.json is not valid JSON"): BundledPluginInventoryItem {
  return Object.freeze({ status: "invalid" as const, manifestPath, reason });
}

test("an importer must be injected", () => {
  assert.throws(() => new PluginHost({ importer: undefined as never }), PluginHostError);
});

test("registers compatible plugins sequentially and carries declarations as data", async () => {
  const order: string[] = [];
  const host = new PluginHost({
    importer: async (entrypointPath) => {
      order.push(`import:${entrypointPath}`);
      return { register: (context: { namespace: string }) => { order.push(`register:${context.namespace}`); } };
    },
  });

  const generation = await host.reload([compatible("alpha", ["network.http"], ["room.message"]), compatible("beta")]);

  assert.deepEqual(order, [
    "import:/bundle/addons/alpha/index.mjs",
    "register:bundled:alpha",
    "import:/bundle/addons/beta/index.mjs",
    "register:bundled:beta",
  ]);
  assert.equal(generation.generation, 1);
  assert.deepEqual(generation.registered.map((entry) => entry.namespace), ["bundled:alpha", "bundled:beta"]);
  assert.deepEqual([...generation.registered[0]!.permissions], ["network.http"]);
  assert.deepEqual([...generation.registered[0]!.requiredCaps], ["room.message"]);
  assert.equal(host.current, generation);
});

test("unavailable and invalid entries are skipped without importing code", async () => {
  const imported: string[] = [];
  const events: PluginHostEvent[] = [];
  const host = new PluginHost({
    importer: async (entrypointPath) => {
      imported.push(entrypointPath);
      return {};
    },
    onEvent: (event) => { events.push(event); },
  });

  const generation = await host.reload([unavailable("old"), invalid("/bundle/addons/broken/plugin.json"), compatible("alpha")]);

  assert.deepEqual(imported, ["/bundle/addons/alpha/index.mjs"]);
  assert.deepEqual(generation.skipped.map((entry) => entry.namespace ?? entry.manifestPath), [
    "bundled:old",
    "/bundle/addons/broken/plugin.json",
  ]);
  assert.equal(events.filter((event) => event.kind === "skipped").length, 2);
});

test("partial failure disposes already-registered plugins in reverse order", async () => {
  const disposed: string[] = [];
  const host = new PluginHost({
    importer: async (entrypointPath) => {
      if (entrypointPath.includes("gamma")) throw new Error("boom");
      return {
        register: (context: { namespace: string }) => ({ dispose: () => { disposed.push(context.namespace); } }),
      };
    },
  });

  await assert.rejects(
    () => host.reload([compatible("alpha"), compatible("beta"), compatible("gamma")]),
    (error: unknown) => error instanceof PluginHostError && error.namespace === "bundled:gamma",
  );
  assert.deepEqual(disposed, ["bundled:beta", "bundled:alpha"]);
  assert.deepEqual([...host.current.registered], []);
  assert.equal(host.current.generation, 0);
});

test("reload is refused while a turn lease is held and swaps generations atomically", async () => {
  const disposed: string[] = [];
  const host = new PluginHost({
    importer: async () => ({ register: (context: { namespace: string }) => () => { disposed.push(context.namespace); } }),
  });
  await host.reload([compatible("alpha")]);

  const release = host.acquireTurnLease();
  assert.equal(host.activeTurnLeases, 1);
  await assert.rejects(() => host.reload([compatible("beta")]), PluginHostError);
  assert.deepEqual(host.current.registered.map((entry) => entry.namespace), ["bundled:alpha"]);
  assert.deepEqual(disposed, []);

  release();
  release();
  assert.equal(host.activeTurnLeases, 0);

  const next = await host.reload([compatible("beta")]);
  assert.equal(next.generation, 2);
  assert.deepEqual(next.registered.map((entry) => entry.namespace), ["bundled:beta"]);
  assert.deepEqual(disposed, ["bundled:alpha"]);
});

test("a failing dispose is reported and never blocks shutdown", async () => {
  const events: PluginHostEvent[] = [];
  const disposed: string[] = [];
  const host = new PluginHost({
    importer: async (entrypointPath) => ({
      register: (context: { namespace: string }) => () => {
        if (entrypointPath.includes("beta")) throw new Error("dispose exploded");
        disposed.push(context.namespace);
      },
    }),
    onEvent: (event) => { events.push(event); },
  });

  await host.reload([compatible("alpha"), compatible("beta")]);
  await host.shutdown();

  assert.deepEqual(disposed, ["bundled:alpha"]);
  assert.deepEqual(events.filter((event) => event.kind === "dispose-failed").map((event) => event.namespace), ["bundled:beta"]);
  assert.deepEqual([...host.current.registered], []);
});

test("a module without register is accepted and a bad dispose is rejected", async () => {
  const bare = new PluginHost({ importer: async () => ({}) });
  const generation = await bare.reload([compatible("alpha")]);
  assert.deepEqual(generation.registered.map((entry) => entry.name), ["alpha"]);

  const bad = new PluginHost({ importer: async () => ({ register: () => ({ dispose: "nope" }) }) });
  await assert.rejects(() => bad.reload([compatible("alpha")]), PluginHostError);

  const notModule = new PluginHost({ importer: async () => 42 });
  await assert.rejects(() => notModule.reload([compatible("alpha")]), PluginHostError);
});
