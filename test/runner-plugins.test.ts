import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The loader reads GAIA_HOME (via globalPaths); each test points it at a fresh
// temp dir, writes .mjs plugins, and restores globalThis.fetch after.
async function withPluginDir(
  plugins: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "gaia-runner-plugins-"));
  const dir = join(home, "plugins", "runner");
  mkdirSync(dir, { recursive: true });
  for (const [file, src] of Object.entries(plugins)) writeFileSync(join(dir, file), src);
  const prevHome = process.env.GAIA_HOME;
  const prevFetch = globalThis.fetch;
  process.env.GAIA_HOME = home;
  try {
    // Import fresh each call so globalPaths re-reads GAIA_HOME at call time
    // (it does — gaiaHome() reads env per-call), and the module-level wrap flag
    // in the loader is irrelevant here (installRunnerPlugins has none).
    const { installRunnerPlugins } = await import("../src/harness/runner-plugins.ts");
    await installRunnerPlugins();
    await run();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("no plugins dir → fetch untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "gaia-runner-plugins-empty-"));
  const prevHome = process.env.GAIA_HOME;
  const prevFetch = globalThis.fetch;
  process.env.GAIA_HOME = home;
  try {
    const { installRunnerPlugins } = await import("../src/harness/runner-plugins.ts");
    await installRunnerPlugins();
    assert.equal(globalThis.fetch, prevFetch);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a wrapFetch plugin composes onto global fetch", async () => {
  await withPluginDir(
    {
      "tag.mjs": `export default {
        name: "tag",
        wrapFetch(next) {
          return (input, init) => next(input, { ...init, headers: { ...(init?.headers ?? {}), "x-tag": "1" } });
        },
      };`,
    },
    async () => {
      let seen;
      globalThis.fetch = ((_input, init) => {
        seen = new Headers(init?.headers).get("x-tag");
        return Promise.resolve(new Response("ok"));
      }) as typeof globalThis.fetch;
      // Re-run the loader so the plugin wraps the stub we just installed.
      const { installRunnerPlugins } = await import("../src/harness/runner-plugins.ts");
      await installRunnerPlugins();
      await globalThis.fetch("https://example.test");
      assert.equal(seen, "1");
    },
  );
});

test("two plugins compose in filename order (both transforms apply)", async () => {
  await withPluginDir(
    {
      "1-a.mjs": `export default { name: "a", wrapFetch(next) {
        return (input, init) => next(input, { ...init, headers: { ...(init?.headers ?? {}), "x-a": "1" } });
      } };`,
      "2-b.mjs": `export default { name: "b", wrapFetch(next) {
        return (input, init) => next(input, { ...init, headers: { ...(init?.headers ?? {}), "x-b": "1" } });
      } };`,
    },
    async () => {
      let a, b;
      globalThis.fetch = ((_input, init) => {
        const h = new Headers(init?.headers);
        a = h.get("x-a");
        b = h.get("x-b");
        return Promise.resolve(new Response("ok"));
      }) as typeof globalThis.fetch;
      const { installRunnerPlugins } = await import("../src/harness/runner-plugins.ts");
      await installRunnerPlugins();
      await globalThis.fetch("https://example.test");
      assert.equal(a, "1");
      assert.equal(b, "1");
    },
  );
});

test("a plugin without wrapFetch is skipped, fetch untouched", async () => {
  await withPluginDir(
    { "noop.mjs": `export default { name: "noop" };` },
    async () => {
      const stub = ((_input, _init) => Promise.resolve(new Response("ok"))) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const { installRunnerPlugins } = await import("../src/harness/runner-plugins.ts");
      await installRunnerPlugins();
      assert.equal(globalThis.fetch, stub);
    },
  );
});

test("a throwing plugin is skipped without breaking the loader", async () => {
  await withPluginDir(
    { "boom.mjs": `throw new Error("boom on import");` },
    async () => {
      const stub = ((_input, _init) => Promise.resolve(new Response("ok"))) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const { installRunnerPlugins } = await import("../src/harness/runner-plugins.ts");
      await installRunnerPlugins(); // must not throw
      assert.equal(globalThis.fetch, stub);
    },
  );
});
