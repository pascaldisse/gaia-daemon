import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  bundledAddonsRoot,
  bundledPluginNamespace,
  listBundledPlugins,
} from "../src/services/bundled-plugins.js";

const repoRoot = join(import.meta.dirname, "..");
const moduleUrl = pathToFileURL(join(repoRoot, "src", "services", "bundled-plugins.ts")).href;

async function writePackage(
  bundleRoot: string,
  directory: string,
  overrides: Readonly<Record<string, unknown>> = {},
  entrypoint = 'throw new Error("inventory imported plugin code");\n',
): Promise<void> {
  const root = join(bundleRoot, "addons", directory);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.mjs"), entrypoint);
  await writeFile(join(root, "plugin.json"), JSON.stringify({
    schema: 1,
    name: `test.${directory}`,
    version: "1.0.0",
    engine: "gaia-daemon@>=2.0.0",
    entrypoint: "./index.mjs",
    permissions: [],
    requiredCaps: [],
    ...overrides,
  }));
}

async function childInventory(bundleRoot: string): Promise<unknown[]> {
  const script = `const api = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await api.listBundledPlugins("2.0.0")));`;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, GAIA_BUNDLE_DIR: bundleRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as unknown[];
}

test("bundled source inventory is empty and namespaced away from legacy plugin registries", async () => {
  assert.equal(bundledAddonsRoot(), join(repoRoot, "addons"));
  assert.deepEqual(await listBundledPlugins("2.0.0"), []);
  assert.equal(bundledPluginNamespace("acme.plugin"), "bundled:acme.plugin");
});

test("compiled-root inventory isolates invalid packages and surfaces incompatible engines", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-bundled-plugins-"));
  try {
    await writePackage(root, "throwing");
    await writePackage(root, "future", { engine: "gaia-daemon@>=3.0.0" });
    await writePackage(root, "invalid", { permissions: ["trust.enable"] });
    const inventory = await childInventory(root) as Array<Record<string, unknown>>;
    assert.deepEqual(inventory.map((item) => item.status), ["unavailable", "invalid", "compatible"]);
    const compatible = inventory.find((item) => item.status === "compatible");
    assert.equal(compatible?.namespace, "bundled:test.throwing");
    const unavailable = inventory.find((item) => item.status === "unavailable");
    assert.match(String(unavailable?.reason), /requires/);
    assert.equal(inventory.filter((item) => item.status === "invalid").length, 1);
    // Both compatible entrypoints throw at module scope; child exit 0 proves inventory did not import either.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing bundled add-ons root is an empty inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-bundled-plugins-missing-"));
  try {
    assert.deepEqual(await childInventory(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled inventory has no dynamic import or dependency on legacy loader modules", async () => {
  const source = await readFile(join(repoRoot, "src", "services", "bundled-plugins.ts"), "utf8");
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /runner-plugins|services\/plugins/);
});
