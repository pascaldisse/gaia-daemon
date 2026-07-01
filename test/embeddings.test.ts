// Embeddings client (memory v3): data-driven provider rows, two wire shapes,
// fail-soft resolution. All network + key lookup is injected — no real calls.

import test from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_PROVIDERS, resolveEmbedder, cosine, textHash } from "../src/services/embeddings.js";
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

const noKeys = async () => undefined;
const withKey = (key: string) => async () => key;

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: Call): any {
  return JSON.parse(call.init.body as string);
}

test("resolveEmbedder: 'off' → undefined", async () => {
  assert.equal(await resolveEmbedder("off", { lookupKey: withKey("sk-x") }), undefined);
});

test("resolveEmbedder: 'auto' with no resolvable keys → undefined", async () => {
  assert.equal(await resolveEmbedder("auto", { lookupKey: noKeys }), undefined);
});

test("resolveEmbedder: 'auto' picks the first provider whose key resolves", async () => {
  const embedder = await resolveEmbedder("auto", {
    lookupKey: async (_envKeys, providerId) => (providerId === "gemini" ? "gm-key" : undefined),
  });
  assert.ok(embedder);
  assert.equal(embedder.id, "gemini");
  assert.equal(embedder.model, "gemini-embedding-001");
});

test("openai shape: request URL/headers/body and Float32Array response", async () => {
  const calls: Call[] = [];
  const fetchImpl = fixedFetch({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, calls);
  const embedder = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  assert.ok(embedder);

  const vectors = await embedder.embed(["hello", "world"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(headersOf(calls[0]).authorization, "Bearer sk-test");
  assert.deepEqual(bodyOf(calls[0]), { model: "text-embedding-3-small", input: ["hello", "world"] });

  assert.equal(vectors.length, 2);
  assert.ok(vectors[0] instanceof Float32Array);
  assert.deepEqual(Array.from(vectors[0]), [1, 2]);
  assert.deepEqual(Array.from(vectors[1]), [3, 4]);
});

test("gemini shape: request URL/headers/body and Float32Array response", async () => {
  const calls: Call[] = [];
  const fetchImpl = fixedFetch({ embeddings: [{ values: [5, 6] }] }, calls);
  const embedder = await resolveEmbedder({ provider: "gemini" }, { fetchImpl, lookupKey: withKey("gm-key") });
  assert.ok(embedder);

  const vectors = await embedder.embed(["hello"]);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
  assert.equal(headersOf(calls[0])["x-goog-api-key"], "gm-key");
  assert.deepEqual(bodyOf(calls[0]), {
    requests: [{ model: "models/gemini-embedding-001", content: { parts: [{ text: "hello" }] } }],
  });
  assert.ok(vectors[0] instanceof Float32Array);
  assert.deepEqual(Array.from(vectors[0]), [5, 6]);
});

test("batching: 200 texts → 3 calls (96/96/8), results concatenated in order", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const input = JSON.parse(init!.body as string).input as string[];
    return new Response(JSON.stringify({ data: input.map((t) => ({ embedding: [Number(t.slice(1))] })) }), { status: 200 });
  }) as typeof fetch;

  const embedder = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
  const vectors = await embedder!.embed(texts);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => bodyOf(c).input.length), [96, 96, 8]);
  assert.equal(vectors.length, 200);
  for (let i = 0; i < 200; i++) assert.equal(vectors[i][0], i);
});

test("non-2xx throws with status + body excerpt", async () => {
  const fetchImpl = fixedFetch({ error: "nope" }, [], 401);
  const embedder = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  await assert.rejects(embedder!.embed(["hello"]), /401.*nope/s);
});

test("response length mismatch throws", async () => {
  const fetchImpl = fixedFetch({ data: [{ embedding: [1] }] }, []);
  const embedder = await resolveEmbedder({ provider: "openai" }, { fetchImpl, lookupKey: withKey("sk-test") });
  await assert.rejects(embedder!.embed(["a", "b"]), /1 vectors for 2 inputs/);
});

test("custom provider: unknown id + baseUrl + envKey → openai-kind row", async () => {
  const calls: Call[] = [];
  const fetchImpl = fixedFetch({ data: [{ embedding: [7] }] }, calls);
  const seen: { envKeys: string[]; providerId: string }[] = [];
  const config: EmbeddingsConfig = { provider: "local", baseUrl: "http://localhost:8080/v1", envKey: "MY_EMBED_KEY", model: "nomic-embed" };
  const embedder = await resolveEmbedder(config, {
    fetchImpl,
    lookupKey: async (envKeys, providerId) => {
      seen.push({ envKeys, providerId });
      return "local-key";
    },
  });
  assert.ok(embedder);
  assert.deepEqual(seen, [{ envKeys: ["MY_EMBED_KEY"], providerId: "local" }]);

  const vectors = await embedder.embed(["x"]);
  assert.equal(calls[0].url, "http://localhost:8080/v1/embeddings");
  assert.equal(headersOf(calls[0]).authorization, "Bearer local-key");
  assert.equal(bodyOf(calls[0]).model, "nomic-embed");
  assert.deepEqual(Array.from(vectors[0]), [7]);
});

test("resolveEmbedder: known provider with missing key → undefined; unknown without baseUrl → undefined", async () => {
  assert.equal(await resolveEmbedder({ provider: "openai" }, { lookupKey: noKeys }), undefined);
  assert.equal(await resolveEmbedder({ provider: "mystery" }, { lookupKey: withKey("k") }), undefined);
});

test("provider table has the two expected rows", () => {
  assert.deepEqual(EMBEDDING_PROVIDERS.map((r) => [r.id, r.kind]), [["openai", "openai"], ["gemini", "gemini"]]);
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
