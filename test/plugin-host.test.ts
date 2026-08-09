import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginHost,
  PluginHostError,
  type PluginHostEvent,
  type PluginHostOptions,
} from "../src/services/plugin-host.js";
import type { BundledPluginInventoryItem } from "../src/services/bundled-plugins.js";
import type { ValidatedPluginManifest } from "../src/services/plugin-manifest.js";

function manifest(name: string, permissions: readonly string[] = [], requiredCaps: readonly string[] = []): ValidatedPluginManifest {
  const addonsRoot = "/bundle/addons";
  const packageRoot = `${addonsRoot}/${name}`;
  return Object.freeze({
    manifestPath: `${packageRoot}/plugin.json`,
    packageRoot,
    addonsRoot,
    daemonVersion: "2.0.0",
    entrypointPath: `${packageRoot}/index.mjs`,
    manifest: Object.freeze({
      schema: 1 as const,
      name,
      version: "1.0.0",
      engine: "gaia-daemon@^2.0.0",
      entrypoint: "./index.mjs",
      permissions: Object.freeze([...permissions]),
      requiredCaps: Object.freeze([...requiredCaps]),
    }),
    engineCompatibility: Object.freeze({ compatible: true }),
    order: 0,
  });
}

function compatible(name: string, permissions?: readonly string[], requiredCaps?: readonly string[]): BundledPluginInventoryItem {
  return Object.freeze({ status: "compatible" as const, namespace: `bundled:${name}`, plugin: manifest(name, permissions, requiredCaps) });
}

function unavailable(name: string, reason = "incompatible daemon engine"): BundledPluginInventoryItem {
  return Object.freeze({ status: "unavailable" as const, namespace: `bundled:${name}`, reason, plugin: manifest(name) });
}

function invalid(manifestPath: string, reason = "plugin.json is not valid JSON"): BundledPluginInventoryItem {
  return Object.freeze({ status: "invalid" as const, manifestPath, reason });
}

function host(options: Omit<PluginHostOptions, "revalidate"> & { revalidate?: PluginHostOptions["revalidate"] }): PluginHost {
  return new PluginHost({ revalidate: async (plugin) => plugin, ...options });
}

const available = (dispose?: () => void | Promise<void>) => ({ status: "available" as const, ...(dispose ? { dispose } : {}) });

test("requires an injected importer", () => {
  assert.throws(() => new PluginHost({ importer: undefined as never }), PluginHostError);
});

test("registers compatible plugins sequentially and carries declarations as non-authoritative data", async () => {
  const order: string[] = [];
  const instance = host({
    importer: async (entrypointPath) => {
      order.push(`import:${entrypointPath}`);
      return { register: (context: { namespace: string }) => { order.push(`register:${context.namespace}`); return available(); } };
    },
  });

  const generation = await instance.reload([compatible("alpha", ["network.http"], ["room.message"]), compatible("beta")]);
  assert.deepEqual(order, [
    "import:/bundle/addons/alpha/index.mjs",
    "register:bundled:alpha",
    "import:/bundle/addons/beta/index.mjs",
    "register:bundled:beta",
  ]);
  assert.equal(generation.generation, 1);
  assert.deepEqual(generation.registered.map((entry) => entry.namespace), ["bundled:alpha", "bundled:beta"]);
  assert.deepEqual(generation.registered[0]?.permissions, ["network.http"]);
  assert.deepEqual(generation.registered[0]?.requiredCaps, ["room.message"]);
  assert.equal(generation.registered[0]?.status, "available");
  assert.equal(instance.current, generation);
});

test("supports v2-style default registration and records plugin-declared unavailability", async () => {
  const instance = host({
    importer: async () => ({ default: () => ({ status: "unavailable", unavailableReason: "feature not configured" }) }),
  });
  const generation = await instance.reload([compatible("alpha")]);
  assert.equal(generation.registered[0]?.status, "unavailable");
  assert.equal(generation.registered[0]?.unavailableReason, "feature not configured");
});

test("manifest-unavailable and invalid entries are skipped without importing code", async () => {
  const imported: string[] = [];
  const events: PluginHostEvent[] = [];
  const instance = host({
    importer: async (entrypointPath) => {
      imported.push(entrypointPath);
      return { register: () => available() };
    },
    onEvent: (event) => { events.push(event); },
  });
  const generation = await instance.reload([unavailable("old"), invalid("/bundle/addons/broken/plugin.json"), compatible("alpha")]);
  assert.deepEqual(imported, ["/bundle/addons/alpha/index.mjs"]);
  assert.deepEqual(generation.skipped.map((entry) => entry.namespace ?? entry.manifestPath), [
    "bundled:old",
    "/bundle/addons/broken/plugin.json",
  ]);
  assert.equal(events.filter((event) => event.kind === "skipped").length, 2);
});

test("preflights forged and duplicate namespaces before any import", async () => {
  const imported: string[] = [];
  const instance = host({ importer: async (path) => { imported.push(path); return { register: () => available() }; } });
  const forged = { ...compatible("alpha"), namespace: "legacy:alpha" } as BundledPluginInventoryItem;
  await assert.rejects(instance.reload([forged]), /non-canonical/);
  await assert.rejects(instance.reload([compatible("alpha"), compatible("alpha")]), /duplicate plugin namespace/);
  assert.deepEqual(imported, []);
});

test("revalidates immediately before import and refuses changed or incompatible packages", async () => {
  const order: string[] = [];
  const instance = new PluginHost({
    revalidate: async (plugin) => { order.push(`validate:${plugin.manifest.name}`); return plugin; },
    importer: async (_path, plugin) => { order.push(`import:${plugin.manifest.name}`); return { register: () => available() }; },
  });
  await instance.reload([compatible("alpha")]);
  assert.deepEqual(order, ["validate:alpha", "import:alpha"]);

  const refused = new PluginHost({
    revalidate: async (plugin) => ({ ...plugin, engineCompatibility: { compatible: false, reason: "changed" } }),
    importer: async () => { throw new Error("must not import"); },
  });
  await assert.rejects(refused.reload([compatible("alpha")]), /engine became incompatible|changed/);
});

test("partial failure disposes already-registered plugins in reverse order", async () => {
  const disposed: string[] = [];
  const instance = host({
    importer: async (entrypointPath) => {
      if (entrypointPath.includes("gamma")) throw new Error("boom");
      return { register: (context: { namespace: string }) => available(() => { disposed.push(context.namespace); }) };
    },
  });
  await assert.rejects(
    instance.reload([compatible("alpha"), compatible("beta"), compatible("gamma")]),
    (error: unknown) => error instanceof PluginHostError && error.namespace === "bundled:gamma",
  );
  assert.deepEqual(disposed, ["bundled:beta", "bundled:alpha"]);
  assert.deepEqual(instance.current.registered, []);
  assert.equal(instance.current.generation, 0);
});

test("malformed registration attempts its valid disposer and never emits registered", async () => {
  let disposed = 0;
  const events: PluginHostEvent[] = [];
  const instance = host({
    importer: async () => ({ register: () => ({ status: "wrong", dispose: () => { disposed += 1; } }) }),
    onEvent: (event) => { events.push(event); },
  });
  await assert.rejects(instance.reload([compatible("alpha")]), PluginHostError);
  assert.equal(disposed, 1);
  assert.equal(events.some((event) => event.kind === "registered"), false);
});

test("rejects missing register, invalid module, status, reason, services, and disposer shapes", async () => {
  const badModules: unknown[] = [
    {},
    42,
    { register: () => undefined },
    { register: () => ({ status: "unavailable" }) },
    { register: () => ({ status: "available", unavailableReason: "no" }) },
    { register: () => ({ status: "available", services: [] }) },
    { register: () => ({ status: "available", dispose: "nope" }) },
  ];
  for (const module of badModules) {
    const instance = host({ importer: async () => module });
    await assert.rejects(instance.reload([compatible("alpha")]), PluginHostError);
  }
});

test("reload is refused while a turn lease is held and swaps generations atomically", async () => {
  const disposed: string[] = [];
  const instance = host({
    importer: async () => ({ register: (context: { namespace: string }) => available(() => { disposed.push(context.namespace); }) }),
  });
  await instance.reload([compatible("alpha")]);
  const release = instance.acquireTurnLease();
  await assert.rejects(instance.reload([compatible("beta")]), PluginHostError);
  assert.deepEqual(instance.current.registered.map((entry) => entry.namespace), ["bundled:alpha"]);
  assert.deepEqual(disposed, []);
  release();
  release();
  const next = await instance.reload([compatible("beta")]);
  assert.equal(next.generation, 2);
  assert.deepEqual(disposed, ["bundled:alpha"]);
});

test("a lease acquired during asynchronous reload rejects the swap and disposes the staged generation", async () => {
  const disposed: string[] = [];
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let blockGamma = false;
  const instance = host({
    importer: async (entrypointPath) => {
      if (blockGamma && entrypointPath.includes("gamma")) await blocked;
      return { register: (context: { namespace: string }) => available(() => { disposed.push(context.namespace); }) };
    },
  });
  await instance.reload([compatible("alpha")]);
  blockGamma = true;
  const reloading = instance.reload([compatible("beta"), compatible("gamma")]);
  await Promise.resolve();
  const release = instance.acquireTurnLease();
  unblock?.();
  await assert.rejects(reloading, PluginHostError);
  assert.deepEqual(disposed, ["bundled:gamma", "bundled:beta"]);
  assert.deepEqual(instance.current.registered.map((entry) => entry.namespace), ["bundled:alpha"]);
  release();
});

test("a rejected reload burns its generation id and a later reload remains possible", async () => {
  const seen: number[] = [];
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let blockBeta = false;
  const instance = host({
    importer: async (entrypointPath) => {
      if (blockBeta && entrypointPath.includes("beta")) await blocked;
      return { register: (context: { generation: number }) => { seen.push(context.generation); return available(); } };
    },
  });
  await instance.reload([compatible("alpha")]);
  blockBeta = true;
  const reloading = instance.reload([compatible("beta")]);
  await Promise.resolve();
  const release = instance.acquireTurnLease();
  unblock?.();
  await assert.rejects(reloading, PluginHostError);
  release();
  blockBeta = false;
  const next = await instance.reload([compatible("gamma")]);
  assert.equal(next.generation, 3);
  assert.equal(new Set(seen).size, seen.length);
});

test("two concurrent reloads serialize by rejection and never double-dispose", async () => {
  const disposed: string[] = [];
  const instance = host({
    importer: async () => ({ register: (context: { namespace: string }) => available(() => { disposed.push(context.namespace); }) }),
  });
  await instance.reload([compatible("alpha")]);
  const first = instance.reload([compatible("beta")]);
  const second = instance.reload([compatible("gamma")]);
  await assert.rejects(second, PluginHostError);
  await first;
  assert.deepEqual(instance.current.registered.map((entry) => entry.namespace), ["bundled:beta"]);
  assert.deepEqual(disposed, ["bundled:alpha"]);
});

test("dispose failures are observable and never block reverse shutdown", async () => {
  const events: PluginHostEvent[] = [];
  const disposed: string[] = [];
  const instance = host({
    importer: async (entrypointPath) => ({
      register: (context: { namespace: string }) => available(() => {
        if (entrypointPath.includes("beta")) throw new Error("dispose exploded");
        disposed.push(context.namespace);
      }),
    }),
    onEvent: (event) => { events.push(event); },
  });
  await instance.reload([compatible("alpha"), compatible("beta")]);
  await instance.shutdown();
  assert.deepEqual(disposed, ["bundled:alpha"]);
  assert.deepEqual(events.filter((event) => event.kind === "dispose-failed").map((event) => event.namespace), ["bundled:beta"]);
});

test("shutdown refuses active leases and remains retryable", async () => {
  const disposed: string[] = [];
  const instance = host({
    importer: async () => ({ register: (context: { namespace: string }) => available(() => { disposed.push(context.namespace); }) }),
  });
  await instance.reload([compatible("alpha")]);
  const release = instance.acquireTurnLease();
  await assert.rejects(instance.shutdown(), PluginHostError);
  assert.deepEqual(disposed, []);
  release();
  await instance.shutdown();
  assert.deepEqual(disposed, ["bundled:alpha"]);
});

test("shutdown is terminal and concurrent idempotent callers await one reverse disposal", async () => {
  const disposals: string[] = [];
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const instance = host({
    importer: async (_path, plugin) => ({
      register: () => available(async () => {
        disposals.push(`start:${plugin.manifest.name}`);
        if (plugin.manifest.name === "beta") await blocked;
        disposals.push(`done:${plugin.manifest.name}`);
      }),
    }),
  });
  await instance.reload([compatible("alpha"), compatible("beta")]);
  const first = instance.shutdown();
  const second = instance.shutdown();
  assert.equal(first, second);
  assert.throws(() => instance.acquireTurnLease(), PluginHostError);
  await assert.rejects(instance.reload([compatible("gamma")]), PluginHostError);
  await Promise.resolve();
  assert.deepEqual(disposals, ["start:beta"]);
  unblock?.();
  await Promise.all([first, second]);
  assert.deepEqual(disposals, ["start:beta", "done:beta", "start:alpha", "done:alpha"]);
  assert.deepEqual(instance.current.registered, []);
});
