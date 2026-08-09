import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_PLUGIN_MANIFEST_BYTES,
  PLUGIN_MANIFEST_SCHEMA,
  PluginManifestError,
  discoverPluginManifests,
  evaluatePluginEngine,
  readPluginManifest,
  readPluginManifests,
  validatePluginManifest,
} from "../src/services/plugin-manifest.js";

const valid = {
  schema: PLUGIN_MANIFEST_SCHEMA,
  name: "acme.plugin",
  version: "1.2.3",
  engine: "gaia-daemon@>=2.0.0",
  entrypoint: "./dist/index.mjs",
  permissions: ["network.http"],
  requiredCaps: ["room.message"],
};

interface Fixture {
  readonly addonsRoot: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly cleanup: () => Promise<void>;
}

async function fixture(manifest: object = valid, packageName = "package"): Promise<Fixture> {
  const addonsRoot = await mkdtemp(join(tmpdir(), "gaia-plugin-manifest-"));
  const packageRoot = join(addonsRoot, packageName);
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "index.mjs"), "export {};\n");
  const manifestPath = join(packageRoot, "plugin.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { addonsRoot, packageRoot, manifestPath, cleanup: () => rm(addonsRoot, { recursive: true, force: true }) };
}

const options = (addonsRoot: string) => ({ addonsRoot, daemonVersion: "2.4.0" });

async function rejectsManifest(action: () => unknown | Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof PluginManifestError && pattern.test(error.message));
}

test("reads a contained manifest without importing code and evaluates its engine", async () => {
  const fx = await fixture();
  try {
    const plugin = await readPluginManifest(fx.manifestPath, { ...options(fx.addonsRoot), order: 4 });
    assert.equal(plugin.order, 4);
    assert.equal(plugin.manifest.name, "acme.plugin");
    assert.deepEqual(plugin.manifest.permissions, ["network.http"]);
    assert.deepEqual(plugin.manifest.requiredCaps, ["room.message"]);
    assert.equal(plugin.engineCompatibility.compatible, true);
    assert.equal(plugin.packageRoot, await realpath(fx.packageRoot));
  } finally {
    await fx.cleanup();
  }
});

test("uses unbounded SemVer 2 precedence and reports incompatible engines without loading failure", async () => {
  assert.equal(evaluatePluginEngine("gaia-daemon@^2.1.0", "2.9.0").compatible, true);
  assert.equal(evaluatePluginEngine("gaia-daemon@^2.1.0", "3.0.0").compatible, false);
  assert.equal(evaluatePluginEngine("gaia-daemon@~2.1.0", "2.2.0").compatible, false);
  assert.equal(evaluatePluginEngine("gaia-daemon@>2.0.0-beta.1", "2.0.0").compatible, true);
  const huge = "9".repeat(400);
  assert.doesNotThrow(() => validatePluginManifest({ ...valid, version: `${huge}.0.0` }, "plugin.json"));
  assert.equal(evaluatePluginEngine(`gaia-daemon@>${huge}.0.0-2`, `${huge}.0.0-10`).compatible, true);

  const fx = await fixture({ ...valid, engine: "gaia-daemon@>=3.0.0" });
  try {
    const plugin = await readPluginManifest(fx.manifestPath, options(fx.addonsRoot));
    assert.equal(plugin.engineCompatibility.compatible, false);
    assert.match(plugin.engineCompatibility.reason ?? "", /requires/);
  } finally {
    await fx.cleanup();
  }
});

test("rejects schema drift, invalid SemVer, unsupported engines, names, and unknown fields", () => {
  for (const [field, value] of [
    ["schema", 2],
    ["name", "System"],
    ["name", "core"],
    ["version", "01.2.3"],
    ["version", "1.2.3-01"],
    ["engine", "gaia >=2"],
    ["engine", "gaia-daemon@2.x"],
  ] as const) {
    assert.throws(() => validatePluginManifest({ ...valid, [field]: value }, "plugin.json"), PluginManifestError);
  }
  assert.throws(() => validatePluginManifest({ ...valid, unexpected: true }, "plugin.json"), /unknown manifest fields/);
});

test("engine ranges exclude prereleases unless the comparator names the same prerelease core", () => {
  assert.equal(evaluatePluginEngine("gaia-daemon@^1.2.3", "2.0.0-rc.1").compatible, false);
  assert.equal(evaluatePluginEngine("gaia-daemon@~1.2.3", "1.3.0-alpha.1").compatible, false);
  assert.equal(evaluatePluginEngine("gaia-daemon@>=1.0.0", "1.2.3-alpha.1").compatible, false);
  assert.equal(evaluatePluginEngine("gaia-daemon@*", "1.2.3-alpha.1").compatible, false);
  assert.equal(evaluatePluginEngine("gaia-daemon@>=1.2.3-alpha.1", "1.2.3-beta.1").compatible, true);
});

test("rejects inherited manifest fields instead of reading through a hostile prototype", () => {
  const inherited = Object.create(valid) as Record<string, unknown>;
  inherited.schema = PLUGIN_MANIFEST_SCHEMA;
  assert.throws(() => validatePluginManifest(inherited, "plugin.json"), /plain JSON object/);
});

test("permissions and capabilities are fixed declarations, never arbitrary trust knobs", () => {
  assert.throws(() => validatePluginManifest({ ...valid, permissions: ["trust.enable"] }, "plugin.json"), /unknown or reserved/);
  assert.throws(() => validatePluginManifest({ ...valid, requiredCaps: ["sandbox.disable"] }, "plugin.json"), /unknown or reserved/);
  assert.throws(() => validatePluginManifest({ ...valid, permissions: null }, "plugin.json"), /unknown or reserved/);
  assert.throws(() => validatePluginManifest({ ...valid, requiredCaps: null }, "plugin.json"), /unknown or reserved/);
  assert.throws(() => validatePluginManifest({ ...valid, requiredCaps: ["room.message", "room.message"] }, "plugin.json"), /duplicates/);
  const omitted = { ...valid } as Record<string, unknown>;
  delete omitted.permissions;
  delete omitted.requiredCaps;
  const parsed = validatePluginManifest(omitted, "plugin.json");
  assert.deepEqual(parsed.permissions, []);
  assert.deepEqual(parsed.requiredCaps, []);
});

test("rejects traversal, backslashes, forbidden extensions, and an escaping entrypoint symlink", async () => {
  for (const entrypoint of ["./dist/../../outside.mjs", ".\\dist\\index.mjs", "./dist/index.node", "./dist//index.mjs"]) {
    assert.throws(() => validatePluginManifest({ ...valid, entrypoint }, "plugin.json"), PluginManifestError);
  }

  const fx = await fixture();
  const outside = join(tmpdir(), `gaia-plugin-escape-${Date.now()}.mjs`);
  try {
    await writeFile(outside, "export {};\n");
    await rm(join(fx.packageRoot, "dist", "index.mjs"));
    await symlink(outside, join(fx.packageRoot, "dist", "index.mjs"));
    await rejectsManifest(() => readPluginManifest(fx.manifestPath, options(fx.addonsRoot)), /inside its declared root/);
  } finally {
    await rm(outside, { force: true });
    await fx.cleanup();
  }
});

test("requires plugin.json in one real direct child and rejects package and manifest symlink escapes", async () => {
  const fx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "gaia-plugin-outside-"));
  try {
    await rejectsManifest(
      () => readPluginManifest(fx.manifestPath, { ...options(fx.addonsRoot), addonsRoot: join(fx.addonsRoot, "wrong") }),
      /direct child|resolve plugin package/,
    );
    await mkdir(join(outside, "dist"));
    await writeFile(join(outside, "dist", "index.mjs"), "export {};\n");
    await writeFile(join(outside, "plugin.json"), JSON.stringify(valid));
    await symlink(outside, join(fx.addonsRoot, "linked-package"));
    await rejectsManifest(
      () => readPluginManifest(join(fx.addonsRoot, "linked-package", "plugin.json"), options(fx.addonsRoot)),
      /inside its declared root/,
    );

    await rm(fx.manifestPath);
    await symlink(join(outside, "plugin.json"), fx.manifestPath);
    await rejectsManifest(() => readPluginManifest(fx.manifestPath, options(fx.addonsRoot)), /inside its declared root/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("preflights duplicate canonical names and identifies both manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-duplicates-"));
  const paths: string[] = [];
  try {
    for (const directory of ["first", "second"]) {
      const packageRoot = join(root, directory);
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await writeFile(join(packageRoot, "dist", "index.mjs"), "export {};\n");
      const path = join(packageRoot, "plugin.json");
      await writeFile(path, JSON.stringify(valid));
      paths.push(path);
    }
    await assert.rejects(
      readPluginManifests(paths, options(root)),
      (error: unknown) => error instanceof PluginManifestError && paths.every((path) => error.message.includes(path)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers only direct directories in deterministic UTF-8 byte order", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-plugin-discovery-"));
  try {
    for (const directory of ["z", "ä", "a"]) await mkdir(join(root, directory));
    await writeFile(join(root, "loose.json"), "{}");
    await mkdir(join(root, "a", "nested"));
    await writeFile(join(root, "a", "nested", "plugin.json"), "{}");
    assert.deepEqual((await discoverPluginManifests(root)).map((path) => basename(join(path, ".."))), ["a", "z", "ä"]);
    assert.deepEqual(await discoverPluginManifests(join(root, "missing")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plugin.json FIFO is rejected without blocking discovery", async () => {
  if (process.platform === "win32") return;
  const fx = await fixture();
  try {
    await rm(fx.manifestPath);
    const process = Bun.spawn(["mkfifo", fx.manifestPath], { stdout: "ignore", stderr: "pipe" });
    assert.equal(await process.exited, 0, await new Response(process.stderr).text());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("FIFO read blocked")), 1000);
    });
    await assert.rejects(Promise.race([readPluginManifest(fx.manifestPath, options(fx.addonsRoot)), timeout]), /regular file/);
    if (timer) clearTimeout(timer);
  } finally {
    await fx.cleanup();
  }
});

test("bounded reader never follows a size check with unbounded readFile", async () => {
  const source = await readFile(new URL("../src/services/plugin-manifest.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /handle\.readFile\(/);
  assert.match(source, /Buffer\.allocUnsafe\(maximum \+ 1\)/);
});

test("bounds manifest bytes and JSON depth and does not permit callers to weaken limits", async () => {
  const huge = await fixture(valid);
  const deep = await fixture(valid, "deep");
  try {
    await writeFile(huge.manifestPath, " ".repeat(DEFAULT_MAX_PLUGIN_MANIFEST_BYTES + 1));
    await rejectsManifest(() => readPluginManifest(huge.manifestPath, options(huge.addonsRoot)), /maximum byte size/);

    await writeFile(deep.manifestPath, JSON.stringify({ ...valid, extra: [[[[[[1]]]]]] }));
    await rejectsManifest(() => readPluginManifest(deep.manifestPath, { ...options(deep.addonsRoot), maxManifestDepth: 4 }), /maximum JSON depth/);
    await rejectsManifest(
      () => readPluginManifest(deep.manifestPath, { ...options(deep.addonsRoot), maxManifestBytes: DEFAULT_MAX_PLUGIN_MANIFEST_BYTES + 1 }),
      /only tighten/,
    );
  } finally {
    await huge.cleanup();
    await deep.cleanup();
  }
});
