// Optional embeddings client for memory v3 (MEMORY-DESIGN.md §Embeddings).
// Exactly two wire shapes — the OpenAI-compatible /embeddings POST and Gemini's
// batchEmbedContents — with providers described as data rows, not branches.
// Fail-soft: no resolvable key → undefined; callers degrade to lexical-only.

import { createHash } from "node:crypto";
import { env } from "../core/env.js";
import { joinUrl, lookupProviderKey } from "./proxy.js";

export interface EmbeddingProviderRow {
  id: string;
  /** Wire shape, not vendor — any OpenAI-compatible endpoint rides "openai". */
  kind: "openai" | "gemini";
  baseUrl: string;
  /** Default model, overridable per config. */
  model: string;
  /** Env var names to try, in order, before the Pi auth store. */
  envKeys: string[];
}

export const EMBEDDING_PROVIDERS: EmbeddingProviderRow[] = [
  { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", envKeys: ["OPENAI_API_KEY"] },
  { id: "gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-embedding-001", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
];

export type EmbeddingsConfig = "auto" | "off" | { provider: string; model?: string; baseUrl?: string; envKey?: string };

export interface Embedder {
  id: string;
  model: string;
  embed(texts: string[], options?: { timeoutMs?: number }): Promise<Float32Array[]>;
}

/** Injection seams for tests; production uses global fetch + env/auth-store lookup. */
export interface EmbedderDeps {
  fetchImpl?: typeof fetch;
  lookupKey?: (envKeys: string[], providerId: string) => Promise<string | undefined>;
}

const BATCH_SIZE = 96;
const DEFAULT_TIMEOUT_MS = 10_000;

// Env vars win (in order), then the Pi auth store — the same source the
// credential proxy reads (proxy.ts). A store error is a soft miss, not a crash.
async function defaultLookupKey(envKeys: string[], providerId: string): Promise<string | undefined> {
  for (const name of envKeys) {
    const value = env(name);
    if (value) return value;
  }
  try {
    return await lookupProviderKey(providerId);
  } catch {
    return undefined;
  }
}

export async function resolveEmbedder(config: EmbeddingsConfig, deps: EmbedderDeps = {}): Promise<Embedder | undefined> {
  if (config === "off") return undefined;
  const lookupKey = deps.lookupKey ?? defaultLookupKey;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (config === "auto") {
    for (const row of EMBEDDING_PROVIDERS) {
      const key = await lookupKey(row.envKeys, row.id);
      if (key) return makeEmbedder(row, key, fetchImpl);
    }
    return undefined;
  }

  const known = EMBEDDING_PROVIDERS.find((r) => r.id === config.provider);
  let row: EmbeddingProviderRow;
  if (known) {
    row = { ...known };
  } else if (config.baseUrl) {
    // Unknown id with an explicit baseUrl → custom OpenAI-compatible endpoint.
    row = { id: config.provider, kind: "openai", baseUrl: config.baseUrl, model: EMBEDDING_PROVIDERS[0].model, envKeys: [] };
  } else {
    return undefined;
  }
  if (config.model) row.model = config.model;
  if (config.baseUrl) row.baseUrl = config.baseUrl;
  if (config.envKey) row.envKeys = [config.envKey];

  const key = await lookupKey(row.envKeys, row.id);
  return key ? makeEmbedder(row, key, fetchImpl) : undefined;
}

function makeEmbedder(row: EmbeddingProviderRow, key: string, fetchImpl: typeof fetch): Embedder {
  return {
    id: row.id,
    model: row.model,
    async embed(texts, options) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        out.push(...(await embedChunk(row, key, texts.slice(i, i + BATCH_SIZE), timeoutMs, fetchImpl)));
      }
      return out;
    },
  };
}

async function embedChunk(row: EmbeddingProviderRow, key: string, texts: string[], timeoutMs: number, fetchImpl: typeof fetch): Promise<Float32Array[]> {
  const openai = row.kind === "openai";
  const url = openai ? joinUrl(row.baseUrl, "embeddings") : joinUrl(row.baseUrl, `models/${row.model}:batchEmbedContents`);
  const headers = { "content-type": "application/json", ...(openai ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key }) };
  const body = openai
    ? { model: row.model, input: texts }
    : { requests: texts.map((text) => ({ model: `models/${row.model}`, content: { parts: [{ text }] } })) };

  const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`embeddings: ${row.id} responded ${response.status}: ${detail}`);
  }
  const parsed = (await response.json()) as { data?: { embedding: number[] }[]; embeddings?: { values: number[] }[] };
  const vectors = openai ? parsed.data?.map((d) => d.embedding) : parsed.embeddings?.map((e) => e.values);
  if (!vectors || vectors.length !== texts.length) {
    throw new Error(`embeddings: ${row.id} returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`);
  }
  return vectors.map((v) => Float32Array.from(v));
}

/** Cosine similarity; 0 when either vector has zero norm. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Content hash used as the embedding-cache key in index.db. */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
