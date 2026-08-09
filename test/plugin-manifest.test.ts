import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PLUGIN_MANIFEST_SCHEMA,
  PluginManifestError,
  readPluginManifest,
  readPluginManifests,
  validatePluginManifest,
} from "../src/services/plugin-manifest.js";

const valid = {
  schema: PLUGIN_MANIFEST_SCHEMA,
  name: "acme.plugin",
  version: "1.2.3",
  engine: "gaia >=2",
  entrypoint: "./dist/index.mjs",
  permissions: ["network.http"],
  requiredCaps: ["room.messages"],
};

async function fixture(manifest: object = valid): Promise<{ root: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-manifest-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "index.mjs"), "export {};\n");
  const manifestPath = join(root, "plugin.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath };
}

async function rejectsManifest(action: () => unknown | Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof PluginManifestError && pattern.test(error.message));
}

test("reads a valid manifest without importing its entrypoint", async () => {
  const { root, manifestPath } = await fixture();
  try {
    const plugin = await readPluginManifest(manifestPath, 4);
    assert.equal(plugin.order, 4);
    assert.equal(plugin.manifest.name, "acme.plugin");
    assert.deepEqual(plugin.manifest.permissions, ["network.http"]);
    assert.deepEqual(plugin.manifest.requiredCaps, ["room.messages"]);
    assert.equal(await lstat(plugin.entrypointPath).then((entry) => entry.isFile()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed schema, version, engine, permissions, and required capabilities", () => {
  for (const [field, value] of [
    ["schema", 2],
    ["version", "v1"],
    ["engine", ""],
    ["permissions", ["Network"]],
    ["requiredCaps", ["room", "room"]],
  ] as const) {
    assert.throws(() => validatePluginManifest({ ...valid, [field]: value }, "plugin.json"), PluginManifestError);
  }
  assert.throws(() => validatePluginManifest({ ...valid, unexpected: true }, "plugin.json"), /unknown manifest fields/);
});

test("rejects lexical traversal before resolving an entrypoint", async () => {
  const { root, manifestPath } = await fixture({ ...valid, entrypoint: "./dist/../../outside.mjs" });
  try {
    await writeFile(join(root, "..", "outside.mjs"), "export {};\n");
    await rejectsManifest(() => readPluginManifest(manifestPath), /inside the plugin package/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an entrypoint symlink which escapes its package after realpath", async () => {
  const { root, manifestPath } = await fixture();
  const outside = join(tmpdir(), `gaia-plugin-escape-${Date.now()}.mjs`);
  try {
    await writeFile(outside, "export {};\n");
    await rm(join(root, "dist", "index.mjs"));
    await symlink(outside, join(root, "dist", "index.mjs"));
    await rejectsManifest(() => readPluginManifest(manifestPath), /inside the plugin package/);
  } finally {
    await rm(outside, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("preflights duplicate names before returning any package", async () => {
  const first = await fixture();
  const second = await fixture({ ...valid, entrypoint: "./dist/index.mjs" });
  try {
    await rejectsManifest(() => readPluginManifests([first.manifestPath, second.manifestPath]), /duplicate plugin name/);
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});
