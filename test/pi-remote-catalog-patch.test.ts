// patches/@earendil-works%2Fpi-coding-agent@0.82.0.patch — remote catalog overlay
// must survive lastModified 0 (404/501 / missing header) yet still drop a
// catalog genuinely older than the builtin data. Exercised through the public
// withRemoteCatalog() surface with an in-memory store, network off.
import { test } from "bun:test";
import assert from "node:assert/strict";

const mod = (await import(
  new URL("./core/remote-catalog-provider.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as {
  REMOTE_CATALOG_REFRESH_INTERVAL_MS: number;
  withRemoteCatalog: (provider: unknown, base?: string, localGeneratedAt?: number) => {
    getModels(): { id: string }[];
    refreshModels(ctx: unknown): Promise<void>;
  };
};

const BUILTIN_AT = 1_700_000_000_000;
const base = { id: "anthropic", getModels: () => [{ id: "builtin-model", provider: "anthropic" }] };
const remote = [{ id: "claude-opus-5-5", provider: "anthropic" }];

async function overlayIds(entry: Record<string, unknown>): Promise<string[]> {
  const p = mod.withRemoteCatalog(base, undefined, BUILTIN_AT);
  await p.refreshModels({ store: { read: async () => entry, write: async () => {} }, allowNetwork: false });
  return p.getModels().map((m) => m.id);
}

test("lastModified 0 + models + recent checkedAt → overlay kept", async () => {
  const ids = await overlayIds({ models: remote, checkedAt: Date.now(), lastModified: 0 });
  assert.ok(ids.includes("claude-opus-5-5"), ids.join(","));
});

test("lastModified undefined + models + recent checkedAt → overlay kept", async () => {
  const ids = await overlayIds({ models: remote, checkedAt: Date.now() });
  assert.ok(ids.includes("claude-opus-5-5"));
});

test("lastModified 0 but checkedAt older than refresh interval → dropped", async () => {
  const ids = await overlayIds({
    models: remote,
    checkedAt: Date.now() - mod.REMOTE_CATALOG_REFRESH_INTERVAL_MS - 1,
    lastModified: 0,
  });
  assert.deepEqual(ids, ["builtin-model"]);
});

test("real lastModified genuinely older than builtin → dropped", async () => {
  const ids = await overlayIds({ models: remote, checkedAt: Date.now(), lastModified: BUILTIN_AT - 1 });
  assert.deepEqual(ids, ["builtin-model"]);
});

test("real lastModified newer than builtin → kept", async () => {
  const ids = await overlayIds({ models: remote, checkedAt: Date.now(), lastModified: BUILTIN_AT + 1 });
  assert.ok(ids.includes("claude-opus-5-5"));
});

test("404 refresh keeps stored lastModified instead of clobbering to 0", async () => {
  const stored = { models: remote, checkedAt: 0, lastModified: BUILTIN_AT + 5 };
  let written: Record<string, unknown> | undefined;
  const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
  try {
    const p = mod.withRemoteCatalog(base, server.url.href, BUILTIN_AT);
    await p.refreshModels({
      store: { read: async () => stored, write: async (e: Record<string, unknown>) => { written = e; } },
      allowNetwork: true,
    });
  } finally {
    server.stop(true);
  }
  assert.equal(written?.lastModified, BUILTIN_AT + 5);
  assert.deepEqual(written?.models, remote);
});
