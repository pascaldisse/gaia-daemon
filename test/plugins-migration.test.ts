import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCommandPlugins, synthesizeLegacyCommandPluginManifest } from "../src/services/plugins.js";

async function manifestPackage(root: string, directory: string, source: string, extra: Record<string, unknown> = {}): Promise<void> {
  const packageRoot = join(root, directory);
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "index.mjs"), source),
    writeFile(join(packageRoot, "plugin.json"), JSON.stringify({
      id: `acme.${directory}`,
      version: "1.0.0",
      engine: "gaia-daemon@^2.0.0",
      placement: "daemon",
      requiredCaps: [],
      contributes: { commands: ["echo"], tools: [], channels: [], providers: [] },
      ...extra,
    })),
  ]);
}

test("manifest command packages register through the typed registry before legacy loose files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-migration-"));
  const bundled = join(root, "bundled");
  const warnings: string[] = [];
  try {
    await mkdir(bundled);
    await manifestPackage(root, "echo", "export default { register: () => ({ contributions: { commands: [{ name: 'echo', description: 'Echo', run: (_context, request) => ({ reply: request.args.join(' ') }) }] } }) };\n");
    await writeFile(join(root, "legacy.mjs"), "export default { command: 'legacy', run: () => ({ reply: 'compat' }) };\n");
    const plugins = await loadCommandPlugins({ bundledDir: bundled, userDir: root, warn: (message) => warnings.push(message) });
    assert.deepEqual(await plugins.get("echo")?.run(["hello", "manifest"], {
      roomId: "room", agentId: "agent", workspaceRoot: root, agents: [],
    }), { reply: "hello manifest" });
    assert.deepEqual(await plugins.get("legacy")?.run([], {
      roomId: "room", agentId: "agent", workspaceRoot: root, agents: [],
    }), { reply: "compat" });
    assert.match(warnings.join("\n"), /deprecated legacy legacy\.mjs; synthesized legacy\.legacy manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one invalid manifest blocks every manifest import before loose compatibility loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-migration-"));
  const bundled = join(root, "bundled");
  const warnings: string[] = [];
  try {
    await mkdir(bundled);
    await manifestPackage(root, "valid", "throw new Error('manifest import ran');\n");
    await manifestPackage(root, "invalid", "export {};\n", { placement: "wrong" });
    await writeFile(join(root, "legacy.mjs"), "export default { command: 'legacy', run: () => ({ reply: 'compat' }) };\n");
    const plugins = await loadCommandPlugins({ bundledDir: bundled, userDir: root, warn: (message) => warnings.push(message) });
    assert.equal(plugins.has("echo"), false);
    assert.equal((await plugins.get("legacy")?.run([], { roomId: "room", agentId: "agent", workspaceRoot: root, agents: [] }))?.reply, "compat");
    assert.match(warnings.join("\n"), /manifest inventory skipped: placement must be daemon or runner/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest command capabilities fail closed before contribution code runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-migration-"));
  const bundled = join(root, "bundled");
  try {
    await mkdir(bundled);
    await manifestPackage(root, "guarded", "export default { register: () => ({ contributions: { commands: [{ name: 'echo', description: 'Guarded', run: () => { throw new Error('contribution code ran'); } }] } }) };\n", {
      requiredCaps: ["room.message"],
    });
    const plugins = await loadCommandPlugins({ bundledDir: bundled, userDir: root, warn: () => {} });
    await assert.rejects(plugins.get("echo")?.run([], { roomId: "room", agentId: "agent", workspaceRoot: root, agents: [] }), /missing capability grant/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy compatibility has an explicit synthetic manifest identity for this release", () => {
  const manifest = synthesizeLegacyCommandPluginManifest("My Plugin.mjs");
  assert.equal(manifest.id, "legacy.my-plugin");
  assert.equal(manifest.version, "0.0.0-legacy");
  assert.equal(manifest.placement, "daemon");
  assert.deepEqual(manifest.requiredCaps, []);
});
