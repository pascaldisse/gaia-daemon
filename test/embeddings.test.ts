// Embeddings client (memory v4, MEMORY-DESIGN.md §6): local-first, verified.
// The two structural guarantees under test: `auto` NEVER touches a cloud
// provider (privacy — failure #7), and no provider is trusted without a
// successful probe embed (key-EXISTS ≠ key-WORKS — failure #1). All network +
// key lookup is injected — no real calls.

import test from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_PROVIDERS, resolveEmbedder, resolveReranker, cosine, textHash } from "../src/services/embeddings.js";
import type { EmbeddingsConfig } from "../src/services/embeddings.js";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stub returning a fixed JSON payload, recording every call. */
function fixedFetch(payload: unknown, calls: Call[], status = 200): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
}

/** One probe-shaped good response: any /embeddings POST answers per input. */
function echoFetch(calls: Call[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const input = JSON.parse(init!.body as string).input as string[];
    return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 2, 3] })) }), { status: 200 });
  }) as typeof fetch;
}

const noKeys = async () => undefined;
const withKey = (key: string) => async () => key;

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: Call): any {
  return JSON.parse(call.init.body as string);
}

test("resolveEmbedder: 'off' → status off, no embedder", async () => {
  const resolved = await resolveEmbedder("off", { lookupKey: withKey("sk-x") });
  assert.equal(resolved.status, "off");
  assert.equal(resolved.embedder, undefined);
});

test("'auto' NEVER touches cloud: sidecar down + cloud keys present → off, zero key lookups", async () => {
  const lookups: string[] = [];
  const calls: Call[] = [];
  const failingFetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const resolved = await resolveEmbedder("auto", {
    fetchImpl: failingFetch,
    lookupKey: async (_envKeys, providerId) => {
      lookups.push(providerId);
      return "sk-a-perfectly-valid-cloud-key";
    },
  });
  assert.equal(resolved.status, "off");
  assert.equal(resolved.embedder, undefined);
  assert.match(resolved.detail, /never uses cloud/);
  assert.deepEqual(lookups, [], "auto must not even LOOK for a cloud key");
  assert.equal(calls.length, 1, "exactly one probe, to the local sidecar");
  assert.match(calls[0].url, /127\.0\.0\.1/);
});

test("'auto' with a live local sidecar → ok, provider local, no key involved", async () => {
  const calls: Call[] = [];
  const resolved = await resolveEmbedder("auto", { fetchImpl: echoFetch(calls), lookupKey: noKeys });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.provider, "local");
  assert.equal(resolved.cloud, false);
  assert.ok(resolved.embedder);
  assert.equal(resolved.embedder.dim, 3, "dim learned from the probe");
  assert.equal(headersOf(calls[0]).authorization, undefined, "no bearer token to a local sidecar");
  assert.match(resolved.detail, /local/);
});

test("probe-at-resolve: an invalid cloud key can no longer masquerade — 401 → dead with the reason", async () => {
  const fetchImpl = fixedFetch({ error: { message: "Incorrect API key provided" } }, [], 401);
  const resolved = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("a1b2c3-not-a-real-key") });
  assert.equal(resolved.status, "dead");
  assert.equal(resolved.embedder, undefined);
  assert.equal(resolved.cloud, true);
  assert.match(resolved.detail, /probe failed/);
  assert.match(resolved.detail, /401/);
});

test("explicit cloud provider that probes OK → ok + cloud:true + consent wording in detail", async () => {
  const calls: Call[] = [];
  const resolved = await resolveEmbedder({ provider: "openai" }, { fetchImpl: echoFetch(calls), lookupKey: withKey("sk-test") });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.cloud, true);
  assert.match(resolved.detail, /leaves this machine/i);
  assert.equal(headersOf(calls[0]).authorization, "Bearer sk-test");
});

test("openai wire shape: URL/headers/body and Float32Array response (after the probe)", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const input = JSON.parse(init!.body as string).input as string[];
    const table: Record<string, number[]> = { hello: [1, 2], world: [3, 4] };
    return new Response(JSON.stringify({ data: input.map((t) => ({ embedding: table[t] ?? [9, 9] })) }), { status: 200 });
  }) as typeof fetch;
  const resolved = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  assert.ok(resolved.embedder);

  const vectors = await resolved.embedder.embed(["hello", "world"]);
  assert.equal(calls.length, 2, "probe + one batch");
  assert.equal(calls[1].url, "https://api.openai.com/v1/embeddings");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(headersOf(calls[1]).authorization, "Bearer sk-test");
  assert.deepEqual(bodyOf(calls[1]), { model: "text-embedding-3-small", input: ["hello", "world"] });
  assert.ok(vectors[0] instanceof Float32Array);
  assert.deepEqual(Array.from(vectors[0]), [1, 2]);
  assert.deepEqual(Array.from(vectors[1]), [3, 4]);
});

test("gemini wire shape: URL/headers/body", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const requests = JSON.parse(init!.body as string).requests as unknown[];
    return new Response(JSON.stringify({ embeddings: requests.map(() => ({ values: [5, 6] })) }), { status: 200 });
  }) as typeof fetch;
  const resolved = await resolveEmbedder({ provider: "gemini" }, { fetchImpl, lookupKey: withKey("gm-key") });
  assert.ok(resolved.embedder);

  const vectors = await resolved.embedder.embed(["hello"]);
  assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
  assert.equal(headersOf(calls[1])["x-goog-api-key"], "gm-key");
  assert.deepEqual(bodyOf(calls[1]), {
    requests: [{ model: "models/gemini-embedding-001", content: { parts: [{ text: "hello" }] } }],
  });
  assert.deepEqual(Array.from(vectors[0]), [5, 6]);
});

test("batching: 200 texts → probe + 3 calls (96/96/8), results concatenated in order", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const input = JSON.parse(init!.body as string).input as string[];
    return new Response(JSON.stringify({ data: input.map((t) => ({ embedding: [t.startsWith("t") ? Number(t.slice(1)) : -1] })) }), { status: 200 });
  }) as typeof fetch;

  const resolved = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
  const vectors = await resolved.embedder!.embed(texts);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map((c) => bodyOf(c).input.length), [96, 96, 8]);
  assert.equal(vectors.length, 200);
  for (let i = 0; i < 200; i++) assert.equal(vectors[i][0], i);
});

test("non-2xx after resolve throws with status + body excerpt", async () => {
  let first = true;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    if (first) {
      first = false;
      const input = JSON.parse(init!.body as string).input as string[];
      return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1] })) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
  }) as typeof fetch;
  const resolved = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  await assert.rejects(resolved.embedder!.embed(["hello"]), /500.*nope/s);
});

test("response length mismatch → dead at probe time", async () => {
  const fetchImpl = fixedFetch({ data: [] }, []);
  const resolved = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  assert.equal(resolved.status, "dead");
  assert.match(resolved.detail, /0 vectors for 1 inputs/);
});

test("custom provider on loopback → treated as local, no key required", async () => {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const config: EmbeddingsConfig = { provider: "my-llama", baseUrl: "http://localhost:8080/v1", model: "nomic-embed" };
  const resolved = await resolveEmbedder(config, {
    fetchImpl: echoFetch(calls),
    lookupKey: async (_envKeys, providerId) => {
      lookups.push(providerId);
      return "should-not-be-needed";
    },
  });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.cloud, false);
  assert.deepEqual(lookups, [], "loopback endpoints need no key");
  assert.equal(calls[0].url, "http://localhost:8080/v1/embeddings");
  assert.equal(bodyOf(calls[0]).model, "nomic-embed");
});

test("custom provider on a REMOTE host → key required (cloud), envKey honored", async () => {
  const calls: Call[] = [];
  const seen: { envKeys: string[]; providerId: string }[] = [];
  const config: EmbeddingsConfig = { provider: "corp", baseUrl: "https://embed.example.com/v1", envKey: "MY_EMBED_KEY" };
  const resolved = await resolveEmbedder(config, {
    fetchImpl: echoFetch(calls),
    lookupKey: async (envKeys, providerId) => {
      seen.push({ envKeys, providerId });
      return "corp-key";
    },
  });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.cloud, true);
  assert.deepEqual(seen, [{ envKeys: ["MY_EMBED_KEY"], providerId: "corp" }]);
  assert.equal(headersOf(calls[0]).authorization, "Bearer corp-key");
});

test("known cloud provider with missing key → dead (loud), unknown without baseUrl → dead", async () => {
  const missing = await resolveEmbedder({ provider: "openai" }, { lookupKey: noKeys });
  assert.equal(missing.status, "dead");
  assert.match(missing.detail, /no API key/);

  const unknown = await resolveEmbedder({ provider: "mystery" }, { lookupKey: withKey("k") });
  assert.equal(unknown.status, "dead");
  assert.match(unknown.detail, /unknown embeddings provider/);
});

test("provider table: local first (the auto pick), then explicit-only cloud rows", () => {
  assert.deepEqual(
    EMBEDDING_PROVIDERS.map((r) => [r.id, r.kind, r.local === true]),
    [
      ["local", "openai", true],
      ["openai", "openai", false],
      ["gemini", "gemini", false],
    ],
  );
});

test("task prompts: embeddinggemma queries/documents get their prefixes; probes and unknown models embed raw", async () => {
  const calls: Call[] = [];
  const resolved = await resolveEmbedder({ provider: "local", baseUrl: "http://127.0.0.1:9999/v1", model: "embeddinggemma-300m" }, { fetchImpl: echoFetch(calls) });
  assert.ok(resolved.embedder);
  assert.deepEqual(bodyOf(calls[0]).input, ["gaia memory embedding probe"], "probe embeds raw text");

  await resolved.embedder.embed(["what did we decide"], { kind: "query" });
  assert.deepEqual(bodyOf(calls[1]).input, ["task: search result | query: what did we decide"]);

  await resolved.embedder.embed(["@user: hello there"], { kind: "document" });
  assert.deepEqual(bodyOf(calls[2]).input, ["title: none | text: @user: hello there"]);

  const plain = await resolveEmbedder({ provider: "local", baseUrl: "http://127.0.0.1:9999/v1", model: "mystery-model" }, { fetchImpl: echoFetch(calls) });
  await plain.embedder!.embed(["raw"], { kind: "query" });
  assert.deepEqual(bodyOf(calls[calls.length - 1]).input, ["raw"], "unknown model families embed raw text");
});

test("'auto' with a daemon sidecar manager: managed URL is used; manager saying no → off (still never cloud)", async () => {
  const calls: Call[] = [];
  const up = await resolveEmbedder("auto", {
    fetchImpl: echoFetch(calls),
    lookupKey: noKeys,
    ensureLocalSidecar: async () => ({ baseUrl: "http://127.0.0.1:4242/v1", model: "embeddinggemma-300m" }),
  });
  assert.equal(up.status, "ok");
  assert.match(calls[0].url, /127\.0\.0\.1:4242/);

  const lookups: string[] = [];
  const down = await resolveEmbedder("auto", {
    fetchImpl: echoFetch([]),
    lookupKey: async (_keys, id) => {
      lookups.push(id);
      return "sk-tempting-cloud-key";
    },
    ensureLocalSidecar: async () => undefined,
  });
  assert.equal(down.status, "off");
  assert.match(down.detail, /never uses cloud/);
  assert.deepEqual(lookups, [], "no cloud fallback even when the sidecar is unavailable");
});

test("cosine: orthogonal → 0, identical → 1, zero vector → 0", () => {
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.ok(Math.abs(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2, 3])) - 1) < 1e-6);
  assert.equal(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1])), 0);
});

test("textHash: stable sha256 hex", () => {
  assert.equal(textHash("abc"), textHash("abc"));
  assert.equal(textHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(textHash("abc"), textHash("abd"));
});

// --- reranker (deep path §8) ---------------------------------------------------------

test("resolveReranker: 'off' → status off; auto without a sidecar/server → off with fusion-order note", async () => {
  const off = await resolveReranker("off", {});
  assert.equal(off.status, "off");
  assert.equal(off.reranker, undefined);

  const failingFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const down = await resolveReranker("auto", { fetchImpl: failingFetch, ensureLocalReranker: async () => undefined });
  assert.equal(down.status, "off");
  assert.match(down.detail, /fusion order/);
});

test("resolveReranker: probe-at-resolve — a live server yields a working rerank fn (scores in document order)", async () => {
  const calls: Call[] = [];
  const rerankFetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const documents = JSON.parse(init!.body as string).documents as string[];
    // Score = document length (deterministic, order-revealing); results
    // deliberately returned in REVERSE order to prove index mapping.
    const results = documents.map((doc, index) => ({ index, relevance_score: doc.length })).reverse();
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as typeof fetch;

  const resolved = await resolveReranker("auto", {
    fetchImpl: rerankFetch,
    ensureLocalReranker: async () => ({ baseUrl: "http://127.0.0.1:4243/v1", model: "bge-reranker-v2-m3" }),
  });
  assert.equal(resolved.status, "ok");
  assert.match(calls[0].url, /127\.0\.0\.1:4243\/v1\/rerank/);
  const scores = await resolved.reranker!.rerank("q", ["aa", "eeee", "c"]);
  assert.deepEqual(scores, [2, 4, 1], "scores aligned to document order regardless of result order");
});

test("resolveReranker: a listening server that cannot rerank → not trusted", async () => {
  const badFetch = (async () => new Response(JSON.stringify({ error: "unsupported" }), { status: 501 })) as typeof fetch;
  const resolved = await resolveReranker("auto", {
    fetchImpl: badFetch,
    ensureLocalReranker: async () => ({ baseUrl: "http://127.0.0.1:4244/v1", model: "bge-reranker-v2-m3" }),
  });
  assert.notEqual(resolved.status, "ok");
  assert.equal(resolved.reranker, undefined);
});
