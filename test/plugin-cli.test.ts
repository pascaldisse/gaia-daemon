import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { runPluginCli } from "../src/services/plugins/cli.js";
import { migratePluginDir } from "../src/services/plugins/migrate.js";
import { fetchPluginRegistry, lookupPluginRegistryEntry, searchPluginRegistry } from "../src/services/plugins/registry-client.js";
import { createTempDir } from "./helpers/temp.js";

async function tmp(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const SAMPLE_REGISTRY = [
  {
    id: "foo",
    name: "Foo",
    description: "a foo extension",
    source: "npm:foo-pkg",
    version: "1.0.0",
    tags: ["example"],
    author: "tester",
    homepage: "https://example.test/foo",
    verified: true,
    added: "2026-09-05",
  },
  {
    id: "bar",
    name: "Bar",
    description: "a bar tool for annotating things",
    source: "git:example.test/bar",
    version: "2.0.0",
    tags: ["annotate"],
    author: "tester",
    homepage: "https://example.test/bar",
    verified: false,
    added: "2026-09-05",
  },
];

test("registry client: fetches, then serves from a fresh 24h cache without refetching", async () => {
  const cache = await tmp("gaia-plugin-registry-cache-");
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(JSON.stringify(SAMPLE_REGISTRY), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await fetchPluginRegistry({ cacheDir: cache.dir, registryUrl: "https://example.test/registry.json" });
    assert.equal(first.length, 2);
    assert.equal(fetchCount, 1);

    // Second call must hit the cache -- fetch would throw if it were called again.
    globalThis.fetch = (async () => {
      throw new Error("network must not be reached while cache is fresh");
    }) as typeof fetch;
    const second = await fetchPluginRegistry({ cacheDir: cache.dir, registryUrl: "https://example.test/registry.json" });
    assert.deepEqual(second, first);

    // noCache forces a refetch even with a fresh cache present.
    let refetched = false;
    globalThis.fetch = (async () => {
      refetched = true;
      return new Response(JSON.stringify(SAMPLE_REGISTRY), { status: 200 });
    }) as typeof fetch;
    await fetchPluginRegistry({ cacheDir: cache.dir, registryUrl: "https://example.test/registry.json", noCache: true });
    assert.equal(refetched, true);
  } finally {
    globalThis.fetch = originalFetch;
    await cache.cleanup();
  }
});

test("registry client: search matches id/name/description/tags; lookup finds by id or source", async () => {
  const cache = await tmp("gaia-plugin-registry-cache-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE_REGISTRY), { status: 200 })) as typeof fetch;
  try {
    const opts = { cacheDir: cache.dir, registryUrl: "https://example.test/registry.json" };
    const bySearch = await searchPluginRegistry("annotat", opts);
    assert.deepEqual(bySearch.map((e) => e.id), ["bar"]);

    const byId = await lookupPluginRegistryEntry("foo", opts);
    assert.equal(byId?.source, "npm:foo-pkg");

    const bySource = await lookupPluginRegistryEntry("git:example.test/bar", opts);
    assert.equal(bySource?.id, "bar");

    const missing = await lookupPluginRegistryEntry("nope", opts);
    assert.equal(missing, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await cache.cleanup();
  }
});

function fakePackageManager(): { pm: PackageManager; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const pm: PackageManager = {
    async resolve() { calls.push({ method: "resolve", args: [] }); return { extensions: [], skills: [], prompts: [], themes: [] }; },
    async install(source, options) { calls.push({ method: "install", args: [source, options] }); },
    async installAndPersist(source, options) { calls.push({ method: "installAndPersist", args: [source, options] }); },
    async remove(source, options) { calls.push({ method: "remove", args: [source, options] }); },
    async removeAndPersist(source, options) { calls.push({ method: "removeAndPersist", args: [source, options] }); return true; },
    async update(source) { calls.push({ method: "update", args: [source] }); },
    listConfiguredPackages() { calls.push({ method: "listConfiguredPackages", args: [] }); return []; },
    async resolveExtensionSources() { return { extensions: [], skills: [], prompts: [], themes: [] }; },
    addSourceToSettings() { return true; },
    removeSourceFromSettings() { return true; },
    setProgressCallback() {},
    getInstalledPath() { return undefined; },
  };
  return { pm, calls };
}

test("plugin cli: install resolves a registry id to its source, then delegates to the injected package manager", async () => {
  const cache = await tmp("gaia-plugin-registry-cache-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE_REGISTRY), { status: 200 })) as typeof fetch;
  const { pm, calls } = fakePackageManager();
  try {
    const code = await runPluginCli(["install", "foo"], {
      packageManager: pm,
      registry: { cacheDir: cache.dir, registryUrl: "https://example.test/registry.json" },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "installAndPersist");
    assert.deepEqual(calls[0]?.args, ["npm:foo-pkg", { local: false }]);
  } finally {
    globalThis.fetch = originalFetch;
    await cache.cleanup();
  }
});

test("plugin cli: install --local passes local scope through; a raw source (unknown id) passes through verbatim", async () => {
  const cache = await tmp("gaia-plugin-registry-cache-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE_REGISTRY), { status: 200 })) as typeof fetch;
  const { pm, calls } = fakePackageManager();
  try {
    const code = await runPluginCli(["install", "npm:not-in-registry", "--local"], {
      packageManager: pm,
      registry: { cacheDir: cache.dir, registryUrl: "https://example.test/registry.json" },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.args, ["npm:not-in-registry", { local: true }]);
  } finally {
    globalThis.fetch = originalFetch;
    await cache.cleanup();
  }
});

test("plugin cli: remove delegates to removeAndPersist", async () => {
  const { pm, calls } = fakePackageManager();
  const code = await runPluginCli(["remove", "npm:foo-pkg"], { packageManager: pm, registry: { registryUrl: "http://127.0.0.1:1/unreachable.json" } });
  assert.equal(code, 0);
  assert.equal(calls[0]?.method, "removeAndPersist");
});

test("plugin cli: unknown subcommand fails with usage", async () => {
  const code = await runPluginCli(["bogus"]);
  assert.equal(code, 1);
});

test("plugin cli: bare invocation prints usage and fails", async () => {
  const code = await runPluginCli([]);
  assert.equal(code, 1);
});

const DEFAULTS_PLUGIN_DIR = join(import.meta.dirname, "..", "plugins", "defaults");

test("migrate: turns a fixture copy of the bundled defaults plugin into a pi package, idempotently", async () => {
  const work = await tmp("gaia-plugin-migrate-");
  const fixtureDir = join(work.dir, "defaults");
  try {
    await mkdir(fixtureDir, { recursive: true });
    await cp(DEFAULTS_PLUGIN_DIR, fixtureDir, { recursive: true });
    // The source tree may itself already be migrated (real `gaia plugin
    // migrate` was run in-tree) -- strip any pre-existing pi package files so
    // this fixture always starts pristine, independent of that state.
    await rm(join(fixtureDir, "package.json"), { force: true });
    await rm(join(fixtureDir, "pi-extension.mjs"), { force: true });

    const first = await migratePluginDir(fixtureDir);
    assert.equal(first.status, "migrated");
    assert.equal(first.pluginId, "gaia.defaults");

    const entryAfterFirst = await readFile(join(fixtureDir, "pi-extension.mjs"), "utf8");
    const packageJsonAfterFirst = await readFile(join(fixtureDir, "package.json"), "utf8");
    const parsedPackageJson = JSON.parse(packageJsonAfterFirst) as { pi?: { extensions?: string[] } };
    assert.deepEqual(parsedPackageJson.pi?.extensions, ["./pi-extension.mjs"]);
    assert.match(entryAfterFirst, /gaia\.defaults/);

    const second = await migratePluginDir(fixtureDir);
    assert.equal(second.status, "up-to-date");
    const entryAfterSecond = await readFile(join(fixtureDir, "pi-extension.mjs"), "utf8");
    const packageJsonAfterSecond = await readFile(join(fixtureDir, "package.json"), "utf8");
    assert.equal(entryAfterSecond, entryAfterFirst);
    assert.equal(packageJsonAfterSecond, packageJsonAfterFirst);
  } finally {
    await work.cleanup();
  }
});

test("migrate: pi's OWN SDK (DefaultResourceLoader + createAgentSession, real in-process) loads the generated pi-extension.mjs and registers the plugin's gaia command as a pi slash command", async () => {
  const work = await tmp("gaia-plugin-migrate-");
  const temp = await createTempDir();
  const fixtureDir = join(work.dir, "fugu");
  try {
    await mkdir(fixtureDir, { recursive: true });
    await cp(join(import.meta.dirname, "..", "plugins", "fugu"), fixtureDir, { recursive: true });
    // Pristine fixture, independent of whatever migration state plugins/fugu
    // itself is currently in (see note in the defaults-fixture test above).
    await rm(join(fixtureDir, "package.json"), { force: true });
    await rm(join(fixtureDir, "pi-extension.mjs"), { force: true });
    const migrated = await migratePluginDir(fixtureDir);
    assert.equal(migrated.status, "migrated");
    assert.deepEqual(migrated.movedToPi, ["commands(1)"]);

    const loader = new DefaultResourceLoader({
      cwd: temp.path,
      agentDir: join(temp.path, "agent-dir"),
      additionalExtensionPaths: [join(fixtureDir, "pi-extension.mjs")],
      noExtensions: false,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: temp.path,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    try {
      const registered = session.extensionRunner.getRegisteredCommands().map((c) => c.name);
      assert.ok(registered.includes("fugu"), `expected "fugu" pi command, got: ${registered.join(", ")}`);
    } finally {
      session.dispose();
    }
  } finally {
    await temp.cleanup();
    await work.cleanup();
  }
});

test("migrate: a directory with no plugin.json is reported skipped, not fatal", async () => {
  const work = await tmp("gaia-plugin-migrate-");
  const notAPackage = join(work.dir, "not-a-package");
  try {
    await mkdir(notAPackage, { recursive: true });
    await writeFile(join(notAPackage, "README.md"), "nothing here\n");
    const result = await migratePluginDir(notAPackage);
    assert.equal(result.status, "skipped");
    assert.ok(result.reason && result.reason.length > 0);
  } finally {
    await work.cleanup();
  }
});

test("plugin cli: migrate subcommand reports a fixture migration end to end", async () => {
  const work = await tmp("gaia-plugin-migrate-");
  const fixtureDir = join(work.dir, "defaults");
  try {
    await mkdir(fixtureDir, { recursive: true });
    await cp(DEFAULTS_PLUGIN_DIR, fixtureDir, { recursive: true });
    await rm(join(fixtureDir, "package.json"), { force: true });
    await rm(join(fixtureDir, "pi-extension.mjs"), { force: true });
    const code = await runPluginCli(["migrate", fixtureDir]);
    assert.equal(code, 0);
    assert.ok(await readFile(join(fixtureDir, "pi-extension.mjs"), "utf8"));
  } finally {
    await work.cleanup();
  }
});
