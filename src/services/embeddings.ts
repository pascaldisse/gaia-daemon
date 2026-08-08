// Embeddings for memory v4 (MEMORY-DESIGN.md §6): LOCAL-FIRST, verified.
//
// Two hard rules, both earned in production:
//  1. `auto` NEVER selects a cloud provider. Persona memory is intimate
//     content; v3's auto-pick-any-key-in-the-environment semantics almost
//     shipped it to OpenAI (failure #7). Local sidecar → otherwise OFF.
//     Cloud is explicit opt-in only, and carries a consent warning.
//  2. Probe-at-resolve: no provider is trusted until one validation embed
//     succeeds. Key-EXISTS is not key-WORKS — v3's invalid key 401'd on every
//     embed forever with no surface (failure #1). A failed probe returns a
//     DEAD provider result the caller must surface in health (§10).
//
// Wire shapes: the OpenAI-compatible /embeddings POST (which llama-server
// speaks on localhost — the `local` provider) and Gemini's batchEmbedContents.
// Providers are data rows, not branches.

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
  /** Localhost sidecar: no key required, content never leaves the machine. */
  local?: boolean;
}

/** The llama.cpp sidecar's default address. The daemon manages the sidecar
 * lifecycle (embed-sidecar.ts) and passes its URL via deps.ensureLocalSidecar;
 * without a manager, `local` resolves only when a server is already listening
 * here (or at the configured baseUrl / GAIA_EMBED_URL). */
export const LOCAL_EMBED_URL_ENV = "GAIA_EMBED_URL";
const DEFAULT_LOCAL_EMBED_URL = "http://127.0.0.1:8790/v1";
export const LOCAL_RERANK_URL_ENV = "GAIA_RERANK_URL";
const DEFAULT_LOCAL_RERANK_URL = "http://127.0.0.1:8791/v1";

export const EMBEDDING_PROVIDERS: EmbeddingProviderRow[] = [
  { id: "local", kind: "openai", baseUrl: DEFAULT_LOCAL_EMBED_URL, model: "embeddinggemma-300m", envKeys: [], local: true },
  { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", envKeys: ["OPENAI_API_KEY"] },
  { id: "gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-embedding-001", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
];

/** Task-prompt templates per embedding model family, keyed by a substring of
 * the model id ("{text}" is replaced). Asymmetric-retrieval models NEED these
 * — embedding raw text silently costs double-digit recall. Data, not branches;
 * unknown models embed raw text. */
export const EMBED_PROMPTS: Array<{ match: string; query: string; document: string }> = [
  { match: "embeddinggemma", query: "task: search result | query: {text}", document: "title: none | text: {text}" },
  {
    match: "qwen3-embedding",
    query: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{text}",
    document: "{text}",
  },
];

export type EmbedKind = "query" | "document";

function applyPrompt(model: string, kind: EmbedKind | undefined, text: string): string {
  if (!kind) return text;
  const row = EMBED_PROMPTS.find((candidate) => model.toLowerCase().includes(candidate.match));
  if (!row) return text;
  return (kind === "query" ? row.query : row.document).replace("{text}", text);
}

export type EmbeddingsConfig = "auto" | "off" | { provider: string; model?: string; baseUrl?: string; envKey?: string };

export interface Embedder {
  id: string;
  model: string;
  /** Vector length, learned from the probe. */
  dim: number;
  /** `kind` selects the model's task prompt (query vs document) — required for
   * asymmetric-retrieval models; omitted = raw text (probes, tests). */
  embed(texts: string[], options?: { timeoutMs?: number; kind?: EmbedKind }): Promise<Float32Array[]>;
}

/** The full story of a resolve attempt — callers surface it in health (§10),
 * never swallow it. `embedder` present ⟺ status "ok". */
export interface ResolvedEmbedder {
  status: "ok" | "off" | "dead";
  embedder?: Embedder;
  provider?: string;
  model?: string;
  detail: string;
  /** Memory content would leave this machine — log the consent warning. */
  cloud?: boolean;
}

/** Injection seams for tests; production uses global fetch + env/auth-store lookup. */
export interface EmbedderDeps {
  fetchImpl?: typeof fetch;
  lookupKey?: (envKeys: string[], providerId: string) => Promise<string | undefined>;
  /** Daemon-managed llama.cpp sidecar (embed-sidecar.ts): bring it up (pull
   * model, spawn, health-gate) and return where it listens. Absent (bare CLI)
   * → the local provider probes its default/configured URL only. */
  ensureLocalSidecar?: (modelId?: string) => Promise<{ baseUrl: string; model: string } | undefined>;
  /** Same manager for the deep-path reranker server (its own port). */
  ensureLocalReranker?: (modelId?: string) => Promise<{ baseUrl: string; model: string } | undefined>;
}

const BATCH_SIZE = 96;
const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TEXT = "gaia memory embedding probe";

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

export async function resolveEmbedder(config: EmbeddingsConfig, deps: EmbedderDeps = {}): Promise<ResolvedEmbedder> {
  if (config === "off") return { status: "off", detail: "embeddings disabled in settings" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookupKey = deps.lookupKey ?? defaultLookupKey;

  if (config === "auto") {
    // auto = local → off. NEVER cloud (design rule; see header).
    const local = { ...EMBEDDING_PROVIDERS[0] };
    const envUrl = env(LOCAL_EMBED_URL_ENV);
    if (envUrl) local.baseUrl = envUrl;
    // The daemon's sidecar manager pulls the model + spawns llama-server on
    // demand; without one (bare CLI) we probe whatever already listens.
    if (deps.ensureLocalSidecar) {
      const up = await deps.ensureLocalSidecar().catch(() => undefined);
      if (up) {
        local.baseUrl = up.baseUrl;
        local.model = up.model;
      } else if (!envUrl) {
        return { status: "off", detail: "local embedding sidecar unavailable (llama-server not installed?) — semantic recall off (auto never uses cloud)" };
      }
    }
    const probed = await probe(local, undefined, fetchImpl);
    if (probed.status === "ok") return probed;
    return {
      status: "off",
      detail: `local embedding sidecar not reachable at ${local.baseUrl} — semantic recall off (auto never uses cloud); ${probed.detail}`,
    };
  }

  const known = EMBEDDING_PROVIDERS.find((row) => row.id === config.provider);
  let row: EmbeddingProviderRow;
  if (known) {
    row = { ...known };
  } else if (config.baseUrl) {
    // Unknown id with an explicit baseUrl → custom OpenAI-compatible endpoint.
    const local = isLoopback(config.baseUrl);
    row = { id: config.provider, kind: "openai", baseUrl: config.baseUrl, model: EMBEDDING_PROVIDERS[0].model, envKeys: [], ...(local ? { local: true } : {}) };
  } else {
    return { status: "dead", provider: config.provider, detail: `unknown embeddings provider "${config.provider}" (no baseUrl given)` };
  }
  if (config.model) row.model = config.model;
  if (config.baseUrl) row.baseUrl = config.baseUrl;
  if (config.envKey) row.envKeys = [config.envKey];

  // Explicit local provider without a fixed endpoint → same managed sidecar
  // as auto, honoring the configured model choice.
  if (row.id === "local" && !config.baseUrl && deps.ensureLocalSidecar) {
    const up = await deps.ensureLocalSidecar(config.model).catch(() => undefined);
    if (!up) return { status: "dead", provider: "local", model: row.model, detail: "local embedding sidecar unavailable (llama-server not installed, model download failed, or startup timed out)" };
    row.baseUrl = up.baseUrl;
    row.model = up.model;
  }

  let key: string | undefined;
  if (!row.local) {
    key = await lookupKey(row.envKeys, row.id);
    if (!key) return { status: "dead", provider: row.id, model: row.model, cloud: true, detail: `no API key found for ${row.id} (${row.envKeys.join(", ") || "no env keys"})` };
  }
  return probe(row, key, fetchImpl);
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** One validation embed before anyone trusts the provider. Failure → dead,
 * with the reason preserved for the health surface. */
async function probe(row: EmbeddingProviderRow, key: string | undefined, fetchImpl: typeof fetch): Promise<ResolvedEmbedder> {
  const cloud = !row.local;
  try {
    const [vec] = await embedChunk(row, key, [PROBE_TEXT], PROBE_TIMEOUT_MS, fetchImpl);
    if (!vec || vec.length === 0) {
      return { status: "dead", provider: row.id, model: row.model, cloud, detail: `${row.id} probe returned an empty vector` };
    }
    return {
      status: "ok",
      embedder: makeEmbedder(row, key, vec.length, fetchImpl),
      provider: row.id,
      model: row.model,
      cloud,
      detail: `${row.id}/${row.model} · dim ${vec.length}${cloud ? " · CLOUD — memory content leaves this machine" : " · local"}`,
    };
  } catch (error) {
    return { status: "dead", provider: row.id, model: row.model, cloud, detail: `${row.id} probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function makeEmbedder(row: EmbeddingProviderRow, key: string | undefined, dim: number, fetchImpl: typeof fetch): Embedder {
  return {
    id: row.id,
    model: row.model,
    dim,
    async embed(texts, options) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const prompted = texts.map((text) => applyPrompt(row.model, options?.kind, text));
      const out: Float32Array[] = [];
      for (let i = 0; i < prompted.length; i += BATCH_SIZE) {
        out.push(...(await embedChunk(row, key, prompted.slice(i, i + BATCH_SIZE), timeoutMs, fetchImpl)));
      }
      return out;
    },
  };
}

async function embedChunk(row: EmbeddingProviderRow, key: string | undefined, texts: string[], timeoutMs: number, fetchImpl: typeof fetch): Promise<Float32Array[]> {
  const openai = row.kind === "openai";
  const url = openai ? joinUrl(row.baseUrl, "embeddings") : joinUrl(row.baseUrl, `models/${row.model}:batchEmbedContents`);
  const headers = {
    "content-type": "application/json",
    ...(key ? (openai ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key }) : {}),
  };
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

// --- reranker (deep path, §8) --------------------------------------------------------
//
// LOCAL-ONLY by design: rerank inputs are (query × candidate memory texts) —
// the same intimate content as embeddings, so the same privacy rule applies,
// and no cloud row even exists. "auto" = managed sidecar (or GAIA_RERANK_URL /
// an already-listening server) → otherwise OFF; search falls back to fusion
// order with a loud health row (§8 kill switch).

export type RerankerConfig = "auto" | "off";

export interface Reranker {
  model: string;
  /** Scores aligned to `documents` order (higher = more relevant). */
  rerank(query: string, documents: string[], options?: { timeoutMs?: number }): Promise<number[]>;
}

export interface ResolvedReranker {
  status: "ok" | "off" | "dead";
  reranker?: Reranker;
  model?: string;
  detail: string;
}

const RERANK_PROBE_TIMEOUT_MS = 5_000;
const RERANK_TIMEOUT_MS = 15_000;

export async function resolveReranker(config: RerankerConfig, deps: EmbedderDeps = {}): Promise<ResolvedReranker> {
  if (config === "off") return { status: "off", detail: "reranker disabled in settings" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  let baseUrl = env(LOCAL_RERANK_URL_ENV);
  let model = "bge-reranker-v2-m3";
  if (!baseUrl && deps.ensureLocalReranker) {
    const up = await deps.ensureLocalReranker().catch(() => undefined);
    if (!up) return { status: "off", detail: "local reranker sidecar unavailable — search uses fusion order" };
    baseUrl = up.baseUrl;
    model = up.model;
  }
  if (!baseUrl) baseUrl = DEFAULT_LOCAL_RERANK_URL;

  // Probe-at-resolve, same rule as embedders: one validation rerank before
  // anyone trusts it. A listening server without rank support fails here.
  try {
    const scores = await rerankCall(fetchImpl, baseUrl, model, "probe", ["gaia reranker probe document"], RERANK_PROBE_TIMEOUT_MS);
    if (scores.length !== 1 || !Number.isFinite(scores[0])) {
      return { status: "dead", model, detail: `reranker probe returned ${scores.length} scores` };
    }
  } catch (error) {
    return { status: "off", model, detail: `reranker not reachable at ${baseUrl} — search uses fusion order (${error instanceof Error ? error.message : String(error)})` };
  }
  return {
    status: "ok",
    model,
    detail: `local/${model} rerank`,
    reranker: {
      model,
      rerank: (query, documents, options) => rerankCall(fetchImpl, baseUrl as string, model, query, documents, options?.timeoutMs ?? RERANK_TIMEOUT_MS),
    },
  };
}

/** llama-server's /v1/rerank wire shape; scores returned in DOCUMENT order. */
async function rerankCall(fetchImpl: typeof fetch, baseUrl: string, model: string, query: string, documents: string[], timeoutMs: number): Promise<number[]> {
  const response = await fetchImpl(joinUrl(baseUrl, "rerank"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, query, documents }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`rerank: server responded ${response.status}: ${detail}`);
  }
  const parsed = (await response.json()) as { results?: Array<{ index: number; relevance_score: number }> };
  if (!parsed.results || parsed.results.length !== documents.length) {
    throw new Error(`rerank: server returned ${parsed.results?.length ?? 0} results for ${documents.length} documents`);
  }
  const scores = new Array<number>(documents.length).fill(0);
  for (const result of parsed.results) {
    if (result.index >= 0 && result.index < scores.length) scores[result.index] = result.relevance_score;
  }
  return scores;
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
