import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, PluginHostError } from "../src/services/plugin-host.js";
import type { BundledPluginInventoryItem } from "../src/services/bundled-plugins.js";
import type { ValidatedPluginManifest } from "../src/services/plugin-manifest.js";

function compatible(name: string): BundledPluginInventoryItem {
  const packageRoot = `/bundle/addons/${name}`;
  const plugin: ValidatedPluginManifest = {
    manifestPath: `${packageRoot}/plugin.json`,
    packageRoot,
    entrypointPath: `${packageRoot}/index.mjs`,
    manifest: {
      schema: 1,
      name,
      version: "1.0.0",
      engine: "gaia-daemon@^1.0.0",
      entrypoint: "index.mjs",
      permissions: [],
      requiredCaps: [],
    },
    engineCompatibility: { compatible: true },
    order: 0,
  };
  return { status: "compatible", namespace: `bundled:${name}`, plugin };
}

// Regression guards for the lease recheck fix (52d8ff3).

test("lease-rejected reload disposes the new generation in reverse order and leaves the old one intact", async () => {
  const disposed: string[] = [];
  let block: Promise<void> | undefined;
  let unblock: (() => void) | undefined;
  const host = new PluginHost({
    importer: async (entrypointPath) => {
      if (entrypointPath.includes("gamma") && block) await block;
      return {
        register: (context: { namespace: string }) => () => { disposed.push(context.namespace); },
      };
    },
  });

  await host.reload([compatible("alpha")]);
  block = new Promise<void>((resolve) => { unblock = resolve; });
  const reloading = host.reload([compatible("beta"), compatible("gamma")]);
  await Promise.resolve();
  const release = host.acquireTurnLease();
  unblock?.();

  await assert.rejects(reloading, PluginHostError);
  assert.deepEqual(disposed, ["bundled:gamma", "bundled:beta"]);
  assert.deepEqual(host.current.registered.map((e) => e.namespace), ["bundled:alpha"]);
  assert.equal(host.current.generation, 1);
  release();
});

test("reload succeeds again after the lease is released (no permanent refusal)", async () => {
  const host = new PluginHost({ importer: async () => ({}) });
  await host.reload([compatible("alpha")]);
  const release = host.acquireTurnLease();
  await assert.rejects(host.reload([compatible("beta")]), PluginHostError);
  release();
  const next = await host.reload([compatible("beta")]);
  assert.deepEqual(next.registered.map((e) => e.namespace), ["bundled:beta"]);
  assert.equal(host.activeTurnLeases, 0);
});

test("two concurrent reloads never double-dispose or corrupt the generation", async () => {
  const disposed: string[] = [];
  const host = new PluginHost({
    importer: async () => ({
      register: (context: { namespace: string }) => () => { disposed.push(context.namespace); },
    }),
  });
  await host.reload([compatible("alpha")]);
  const first = host.reload([compatible("beta")]);
  const second = host.reload([compatible("gamma")]);
  await assert.rejects(second, PluginHostError);
  await first;
  assert.deepEqual(host.current.registered.map((e) => e.namespace), ["bundled:beta"]);
  assert.deepEqual(disposed, ["bundled:alpha"]);
  assert.equal(host.current.generation, 2);
});

// ATTACK 1: generation numbers are reused after a lease-rejected reload, so two
// distinct plugin instances observe the same generation id.
test("ATTACK: a rejected reload must not hand its generation number to the next one", async () => {
  const seen: number[] = [];
  let block: Promise<void> | undefined;
  let unblock: (() => void) | undefined;
  const host = new PluginHost({
    importer: async (entrypointPath) => {
      if (entrypointPath.includes("beta") && block) await block;
      return { register: (context: { generation: number }) => { seen.push(context.generation); } };
    },
  });

  await host.reload([compatible("alpha")]);
  block = new Promise<void>((resolve) => { unblock = resolve; });
  const reloading = host.reload([compatible("beta")]);
  await Promise.resolve();
  const release = host.acquireTurnLease();
  unblock?.();
  await assert.rejects(reloading, PluginHostError);
  release();
  block = undefined;
  await host.reload([compatible("gamma")]);

  assert.equal(new Set(seen).size, seen.length, `generation ids reused: ${seen.join(",")}`);
});

// ATTACK 2: shutdown ignores the lease invariant reload enforces, so a running
// turn can have every plugin disposed underneath it.
test("ATTACK: shutdown must respect active turn leases", async () => {
  const disposed: string[] = [];
  const host = new PluginHost({
    importer: async () => ({
      register: (context: { namespace: string }) => () => { disposed.push(context.namespace); },
    }),
  });
  await host.reload([compatible("alpha")]);
  const release = host.acquireTurnLease();
  await assert.rejects(host.shutdown(), PluginHostError);
  assert.deepEqual(disposed, []);
  release();
});
