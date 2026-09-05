import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  PluginManifestError,
  discoverPluginManifests,
  readPluginManifest,
  readPluginManifests,
  validatePluginManifest,
} from "../src/services/plugins/manifest.js";

const valid = {
  id: "acme.echo",
  version: "1.2.3",
  engine: "gaia-daemon@^2.0.0",
  placement: "daemon",
  requiredCaps: ["room.message"],
  contributes: { commands: ["echo"], tools: [], channels: [], providers: [] },
};

async function fixture(name = "echo", manifest: object = valid): Promise<{ root: string; packageRoot: string; manifestPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugins-"));
  const packageRoot = join(root, name);
  await mkdir(packageRoot);
  const manifestPath = join(packageRoot, "plugin.json");
  await Promise.all([writeFile(manifestPath, JSON.stringify(manifest)), writeFile(join(packageRoot, "index.mjs"), "export default {};\n")]);
  return { root, packageRoot, manifestPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("validates the declared manifest contract without importing plugin code", async () => {
  const fx = await fixture();
  try {
    const plugin = await readPluginManifest(fx.manifestPath, { pluginsRoot: fx.root, order: 3 });
    assert.equal(plugin.order, 3);
    assert.equal(plugin.manifest.id, "acme.echo");
    assert.equal(plugin.manifest.placement, "daemon");
    assert.deepEqual(plugin.manifest.contributes.commands, ["echo"]);
    assert.equal(plugin.packageRoot, await realpath(fx.packageRoot));
  } finally {
    await fx.cleanup();
  }
});

test("rejects schema drift, malformed declarations, and invalid placement", () => {
  for (const manifest of [
    { ...valid, entrypoint: "./evil.mjs" },
    { ...valid, id: "Acme" },
    { ...valid, version: "01.2.3" },
    { ...valid, placement: "host" },
    { ...valid, process: "daemon" },
    { ...valid, requiredCaps: ["room.message", "room.message"] },
    { ...valid, contributes: { ...valid.contributes, tools: ["unsafe tool"] } },
    { ...valid, contributes: { commands: [], tools: [], channels: [] } },
  ]) assert.throws(() => validatePluginManifest(manifest, "plugin.json"), PluginManifestError);
});

test("rejects package, manifest, and entrypoint realpath escapes before code import", async () => {
  const fx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "gaia-plugins-outside-"));
  try {
    await writeFile(join(outside, "index.mjs"), "export default {};\n");
    await rm(join(fx.packageRoot, "index.mjs"));
    await symlink(join(outside, "index.mjs"), join(fx.packageRoot, "index.mjs"));
    await assert.rejects(readPluginManifest(fx.manifestPath, { pluginsRoot: fx.root }), PluginManifestError);

    await mkdir(join(outside, "linked"));
    await Promise.all([writeFile(join(outside, "linked", "plugin.json"), JSON.stringify(valid)), writeFile(join(outside, "linked", "index.mjs"), "export default {};\n")]);
    await symlink(join(outside, "linked"), join(fx.root, "linked"));
    await assert.rejects(readPluginManifest(join(fx.root, "linked", "plugin.json"), { pluginsRoot: fx.root }), PluginManifestError);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("preflights duplicate IDs and discovers direct package directories deterministically", async () => {
  const first = await fixture("z");
  try {
    const second = join(first.root, "a");
    await mkdir(second);
    await Promise.all([writeFile(join(second, "plugin.json"), JSON.stringify({ ...valid, id: "acme.echo" })), writeFile(join(second, "index.mjs"), "export default {};\n")]);
    const paths = await discoverPluginManifests(first.root);
    assert.deepEqual(paths.map((path) => path.split("/").at(-2)), ["a", "z"]);
    await assert.rejects(readPluginManifests(paths, { pluginsRoot: first.root }), /duplicate plugin id/);
  } finally {
    await first.cleanup();
  }
});
