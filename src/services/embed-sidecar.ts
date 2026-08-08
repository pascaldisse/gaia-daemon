// The local model sidecar (MEMORY-DESIGN.md §6, §8): daemon-managed
// llama.cpp `llama-server` processes on private localhost ports. Nothing
// leaves the machine — this is what makes `embeddings: "auto"` (and the deep
// path's reranker) resolvable without cloud.
//
// Lifecycle, same shape as the voice engines: model pulled ONCE into
// ~/.gaia/cache/models/ (sha256-verified, atomic rename), server spawned on
// demand, health-gated before use, idle-shutdown after a quiet period. A
// server that is ALREADY listening on the port (user-run, or one left over
// from a previous daemon) is reused, never killed — we only ever stop a child
// we spawned. llama-server serves ONE model per process, so each ROLE
// (embedding, rerank) gets its own port + child; role differences are data
// on ROLE_SPECS, not branches.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../core/env.js";
import { globalPaths } from "../core/paths.js";

export type SidecarRole = "embedding" | "rerank";

/** Per-role wiring — port, server flags, env override — read uniformly. */
interface RoleSpec {
  port: number;
  args: string[];
  envUrl: string;
}

const ROLE_SPECS: Record<SidecarRole, RoleSpec> = {
  embedding: { port: 8790, args: ["--embeddings"], envUrl: "GAIA_EMBED_URL" },
  rerank: { port: 8791, args: ["--rerank"], envUrl: "GAIA_RERANK_URL" },
};

/** Model registry — data, not branches. sha256 pins the exact artifact. */
export interface EmbedModelRow {
  id: string;
  role: SidecarRole;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Native output width (embedding rows only; storage truncates further). */
  dim?: number;
}

export const EMBED_MODELS: EmbedModelRow[] = [
  {
    // The size/quality knee (§6): ~320MB resident, MRL-truncatable.
    id: "embeddinggemma-300m",
    role: "embedding",
    file: "embeddinggemma-300M-Q8_0.gguf",
    url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf",
    sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
    bytes: 333_590_944,
    dim: 768,
  },
  {
    // The quality ceiling option; pick via memory.embeddings.model.
    id: "qwen3-embedding-0.6b",
    role: "embedding",
    file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    url: "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
    sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    bytes: 639_150_592,
    dim: 1024,
  },
  {
    // Deep-path reranker (§8): llama.cpp's reference reranker, with a real
    // classification head. (The design named Qwen3-Reranker-0.6B, but every
    // available GGUF conversion lacks the rank head — llama-server loads them
    // under --rerank and mis-ranks; verified live against two conversions.
    // bge-reranker-v2-m3 separates relevant from noise by 6+ logits.)
    id: "bge-reranker-v2-m3",
    role: "rerank",
    file: "bge-reranker-v2-m3-Q8_0.gguf",
    url: "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf",
    sha256: "a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3",
    bytes: 635_676_416,
  },
];

export const DEFAULT_EMBED_MODEL = "embeddinggemma-300m";
export const DEFAULT_RERANK_MODEL = "bge-reranker-v2-m3";
const DEFAULT_MODEL_FOR_ROLE: Record<SidecarRole, string> = { embedding: DEFAULT_EMBED_MODEL, rerank: DEFAULT_RERANK_MODEL };
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const SPAWN_HEALTH_TIMEOUT_MS = 60_000;

export interface EmbedSidecarOptions {
  log?: (message: string) => void;
  /** Download/startup progress for the health surface ("downloading 42%").
   * `role` routes it to the right health row (embedder vs reranker). */
  onProgress?: (state: "downloading" | "starting" | "ready" | "failed", detail: string, role: SidecarRole) => void;
  /** Port overrides per role (tests). */
  ports?: Partial<Record<SidecarRole, number>>;
  /** Injection seams for tests. */
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  binaryPath?: () => string | undefined;
}

interface RoleState {
  child?: ChildProcess;
  childModel?: string;
  idleTimer?: NodeJS.Timeout;
  ensuring?: Promise<{ baseUrl: string; model: string } | undefined>;
}

export class EmbedSidecar {
  private readonly roles = new Map<SidecarRole, RoleState>();

  constructor(private readonly options: EmbedSidecarOptions = {}) {}

  private log(message: string): void {
    this.options.log?.(`embed-sidecar: ${message}`);
  }

  private state(role: SidecarRole): RoleState {
    let state = this.roles.get(role);
    if (!state) {
      state = {};
      this.roles.set(role, state);
    }
    return state;
  }

  private port(role: SidecarRole): number {
    return this.options.ports?.[role] ?? ROLE_SPECS[role].port;
  }

  private baseUrl(role: SidecarRole): string {
    return `http://127.0.0.1:${this.port(role)}/v1`;
  }

  /** Bring the embedding server up (reuse → spawn → download+spawn) and return
   * where it listens. `undefined` = genuinely unavailable (no binary); the
   * caller's resolve path reports that in health. */
  ensure(modelId?: string): Promise<{ baseUrl: string; model: string } | undefined> {
    return this.ensureRole("embedding", modelId);
  }

  /** Same lifecycle for the deep-path reranker on its own port. */
  ensureRerank(modelId?: string): Promise<{ baseUrl: string; model: string } | undefined> {
    return this.ensureRole("rerank", modelId);
  }

  /** Serialized per role: concurrent callers share one attempt. */
  ensureRole(role: SidecarRole, modelId?: string): Promise<{ baseUrl: string; model: string } | undefined> {
    const wanted = modelId && EMBED_MODELS.some((row) => row.id === modelId && row.role === role) ? modelId : DEFAULT_MODEL_FOR_ROLE[role];
    const state = this.state(role);
    if (!state.ensuring) {
      state.ensuring = this.ensureInner(role, wanted).finally(() => {
        state.ensuring = undefined;
      });
    }
    this.touch(role);
    return state.ensuring;
  }

  private async ensureInner(role: SidecarRole, modelId: string): Promise<{ baseUrl: string; model: string } | undefined> {
    // An explicit external endpoint wins — unmanaged, never spawned or killed.
    const envUrl = env(ROLE_SPECS[role].envUrl);
    if (envUrl) return { baseUrl: envUrl, model: modelId };

    const state = this.state(role);
    // Our child (right model) still up → done. A different model → replace.
    if (state.child && state.childModel === modelId && (await this.healthy(role))) return { baseUrl: this.baseUrl(role), model: modelId };
    if (state.child && state.childModel !== modelId) this.stopChild(role, "model switch");

    // Someone else's server on the port → reuse, don't manage.
    if (!state.child && (await this.healthy(role))) return { baseUrl: this.baseUrl(role), model: modelId };

    const binary = (this.options.binaryPath ?? defaultBinaryPath)();
    if (!binary) return undefined;

    const row = EMBED_MODELS.find((candidate) => candidate.id === modelId) as EmbedModelRow;
    const modelPath = await this.ensureModelFile(row);

    this.options.onProgress?.("starting", `${row.id} starting on :${this.port(role)}`, role);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    // Non-causal embedding/rank models process each input in ONE physical
    // batch: ubatch must cover the longest single input or the server 500s
    // ("input too large"). Chunks are ≤1000 chars but byte-fallback
    // tokenization can exceed 2 tokens/char on exotic content — 4096 covers
    // the worst case (rerank inputs are query+document, still well under).
    const child = spawnImpl(
      binary,
      ["-m", modelPath, ...ROLE_SPECS[role].args, "--host", "127.0.0.1", "--port", String(this.port(role)), "--ctx-size", "4096", "--batch-size", "4096", "--ubatch-size", "4096"],
      { stdio: "ignore" },
    );
    state.child = child;
    state.childModel = modelId;
    child.on("exit", (code) => {
      if (state.child === child) {
        state.child = undefined;
        this.log(`llama-server exited (${code ?? "signal"})`);
      }
    });

    const started = Date.now();
    while (Date.now() - started < SPAWN_HEALTH_TIMEOUT_MS) {
      if (await this.healthy(role)) {
        this.log(`llama-server up on :${this.port(role)} (${row.id})`);
        this.options.onProgress?.("ready", `${row.id} on 127.0.0.1:${this.port(role)}`, role);
        this.touch(role);
        return { baseUrl: this.baseUrl(role), model: modelId };
      }
      if (!state.child) break; // crashed during startup
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    this.stopChild(role, "failed to become healthy");
    this.options.onProgress?.("failed", `${row.id} did not become healthy within ${SPAWN_HEALTH_TIMEOUT_MS / 1000}s`, role);
    return undefined;
  }

  /** The pinned model file, downloading + sha256-verifying on first use. */
  private async ensureModelFile(row: EmbedModelRow): Promise<string> {
    const dir = globalPaths.modelsCacheDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, row.file);
    if (existsSync(path) && statSync(path).size === row.bytes) return path;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    this.log(`downloading ${row.id} (${Math.round(row.bytes / 1e6)}MB) → ${path}`);
    this.options.onProgress?.("downloading", `${row.id} 0%`, row.role);
    const response = await fetchImpl(row.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`model download failed: ${response.status} for ${row.url}`);

    const tmp = `${path}.download`;
    const hasher = createHash("sha256");
    let received = 0;
    let lastPct = -1;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        hasher.update(chunk);
        received += chunk.length;
        const pct = Math.floor((received / row.bytes) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          this.options.onProgress?.("downloading", `${row.id} ${pct}%`, row.role);
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, createWriteStream(tmp));

    const digest = hasher.digest("hex");
    if (digest !== row.sha256) {
      await rm(tmp, { force: true });
      throw new Error(`model checksum mismatch for ${row.file}: got ${digest}, pinned ${row.sha256}`);
    }
    await rename(tmp, path);
    this.log(`downloaded + verified ${row.file}`);
    return path;
  }

  private async healthy(role: SidecarRole): Promise<boolean> {
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(`http://127.0.0.1:${this.port(role)}/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Bump a role's idle clock; its server dies quietly after IDLE_SHUTDOWN_MS
   * without calls and respawns on the next ensure(). */
  touch(role: SidecarRole = "embedding"): void {
    const state = this.state(role);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (state.child) this.stopChild(role, `idle ${IDLE_SHUTDOWN_MS / 60_000}min`);
    }, IDLE_SHUTDOWN_MS);
    state.idleTimer.unref?.();
  }

  private stopChild(role: SidecarRole, reason: string): void {
    const state = this.state(role);
    const child = state.child;
    if (!child) return;
    state.child = undefined;
    state.childModel = undefined;
    this.log(`stopping llama-server :${this.port(role)} (${reason})`);
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  dispose(): void {
    for (const [role, state] of this.roles) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      this.stopChild(role, "daemon shutdown");
    }
  }
}

function defaultBinaryPath(): string | undefined {
  for (const candidate of ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server", "/usr/bin/llama-server"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Read a model row (settings hints + the resolve path share the registry). */
export function embedModelRow(id: string): EmbedModelRow | undefined {
  return EMBED_MODELS.find((row) => row.id === id);
}

/** True when the pinned model file is already on disk (status surfaces). */
export function modelFilePresent(id: string): boolean {
  const row = embedModelRow(id);
  if (!row) return false;
  const path = join(globalPaths.modelsCacheDir(), row.file);
  try {
    return statSync(path).size === row.bytes;
  } catch {
    return false;
  }
}
