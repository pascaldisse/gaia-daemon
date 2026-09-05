import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { loadPlugins } from "../src/services/plugins/loader.js";

async function packageAt(root: string, directory: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const packageRoot = join(root, directory);
  await mkdir(packageRoot);
  await Promise.all([
    writeFile(join(packageRoot, "index.mjs"), "throw new Error('must only run through importer');\n"),
    writeFile(join(packageRoot, "plugin.json"), JSON.stringify({
      id: `acme.${directory}`,
      version: "1.0.0",
      engine: "gaia-daemon@^2.0.0",
      placement: "daemon",
      requiredCaps: [],
      contributes: { commands: [], tools: [], channels: [], providers: [] },
      ...overrides,
    })),
  ]);
}

test("validates every manifest before calling the importer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-loader-"));
  const imported: string[] = [];
  try {
    await packageAt(root, "first");
    await packageAt(root, "broken", { placement: "invalid" });
    await assert.rejects(loadPlugins(root, "daemon", async (_path, plugin) => {
      imported.push(plugin.manifest.id);
      return {};
    }), /placement must be daemon or runner/);
    assert.deepEqual(imported, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filters only after global validation and imports contained selected packages in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-loader-"));
  try {
    await packageAt(root, "z");
    await packageAt(root, "a", { placement: "runner" });
    const imported: string[] = [];
    const plugins = await loadPlugins(root, "daemon", async (_path, plugin) => {
      imported.push(plugin.manifest.id);
      return { id: plugin.manifest.id };
    });
    assert.deepEqual(imported, ["acme.z"]);
    assert.deepEqual(plugins.map((plugin) => plugin.module), [{ id: "acme.z" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
