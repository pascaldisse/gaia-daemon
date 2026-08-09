import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  bundledAddonsRoot,
  bundledPluginNamespace,
  listBundledPlugins,
} from "../src/services/bundled-plugins.js";

test("bundled discovery reads the shipped malicious fixture without importing its entrypoint", async () => {
  const root = bundledAddonsRoot();
  const entrypoint = join(root, "discovery-fixture", "malicious.mjs");
  assert.match(await readFile(entrypoint, "utf8"), /throw new Error/);

  const plugins = await listBundledPlugins("2.0.0");
  const fixture = plugins.find((plugin) => plugin.status === "available" && plugin.plugin.manifest.name === "gaia.discovery-fixture");
  assert.ok(fixture, "fixture manifest must be discovered");
  assert.equal(fixture.namespace, "bundled:gaia.discovery-fixture");
  assert.equal(fixture.plugin.entrypointPath, entrypoint);
});

test("bundled namespace is data-only and stable", () => {
  assert.equal(bundledPluginNamespace("acme.plugin"), "bundled:acme.plugin");
});
