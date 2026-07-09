// One MemoryService per workspace: episodic capture, global hybrid recall
// (shared by the recall tool, the harness HTTP bridge, per-turn auto-recall,
// and /recall), the embedding cache, health state, and the debounced
// consolidation loop. Memory is a daemon service — harnesses reach it only
// through uniform surfaces, so nothing in here knows which harness is asking.
//
// v4 (MEMORY-DESIGN.md): recall runs against ONE workspace index (global bm25
// over transcript chunks + the agent's facts/episodes), degradation is LOUD
// (health table + flags on every result), and the embedder is local-first —
// `auto` never selects cloud, and no provider is trusted without a probe.

import { join } from "node:path";
import type { AgentDef, MemoryConfig } from "../core/types.js";
import { newId } from "../core/ids.js";
import { resolveMemoryConfig } from "../core/config.js";
import type { DatabaseSync } from "node:sqlite";
import type { Episode, EpisodeOutcome } from "../domain/episodes.js";
import { appendEpisode, purgeRoomEpisodes } from "../domain/episodes.js";
import type { ActiveContextRef, MemoryHealthRow, MemorySearchHit, RoomRef, TranscriptSearchHit } from "../domain/workspace-index.js";
import {
  countEmbeddings,
  expandChunkWindows,
  formatMemoryHits,
  openWorkspaceIndex,
  pendingEmbeddings,
  purgeRoomIndex,
  readHealth,
  searchTranscripts,
  searchWorkspaceIndex,
  setHealth,
  storeEmbeddings,
  sharedMemorySource,
  syncWorkspaceIndex,
} from "../domain/workspace-index.js";
import type { MemoryStore } from "../domain/memory.js";
import type { ApplyDreamProposalResult, ConsolidateLlm, ConsolidateResult } from "./consolidate.js";
import { applyDreamProposal, runConsolidation } from "./consolidate.js";
import type { EmbedderDeps, ResolvedEmbedder, ResolvedReranker } from "./embeddings.js";
import { resolveEmbedder, resolveReranker } from "./embeddings.js";

// Latency guards on the hot path (auto-recall runs before every turn).
const QUERY_EMBED_TIMEOUT_MS = 800;
// A search query must fit the embedder's ONE physical batch — a non-causal
// model processes each input whole, so an over-long query is a hard 500
// ("input too large"), not a slow embed, and retry-once can't rescue a
// deterministically-too-long input. ~1200 chars stays under a stock
// llama-server's 512-token batch even for exotic (byte-fallback) text, and a
// recall probe longer than this is a context blob that hurts retrieval anyway.
const QUERY_EMBED_MAX_CHARS = 1_200;
const EMBED_SYNC_DEBOUNCE_MS = 5_000;
const INDEX_SYNC_BUDGET_MS = 1_000;
// A single search over budget is normal (a cold sidecar's first call, GPU
// contention, an unusually large query) — not a fault. Only latch the loud
// "recall degraded" chip once recall is slow this many times in a row, so the
// warning means a persistent problem, not one spike; any fast pass clears it.
const SLOW_RECALL_MS = 1_500;
const SLOW_RECALL_STREAK = 3;

// Auto-recall precision gates: relative to the top hit plus an absolute
// floor, so weak matches stay silent instead of padding the prompt. Scores
// are max-normalized bm25 × weights (≈0..1.4), not v3's tiny RRF sums.
const AUTO_RECALL_RELATIVE_GATE = 0.3;
const AUTO_RECALL_MIN_SCORE = 0.05;
const AUTO_RECALL_LIMIT = 5;

// Deep path (§8): explicit invocation tolerates seconds — cast a wide fused
// net, rerank the head, widen survivors to their chunk neighborhood.
const DEEP_CANDIDATES = 100;
const DEEP_RERANK_TOP = 20;
const DEEP_LIMIT = 8;
const SUMMARIZE_HITS = 12;
const SUMMARIZE_INPUT_BUDGET = 16_000;

export interface EpisodeCapture {
  roomId: string;
  task: string;
  reply: string;
  outcome: EpisodeOutcome;
  tools?: string[];
  channel?: "text" | "voice";
}

export interface MemorySearchRequest {
  limit?: number;
  includeInvalidated?: boolean;
  /** The asking agent's active context window — same-room hits inside it are
   * excluded (self-match, CALMem §7); compacted-away content stays reachable. */
  context?: ActiveContextRef;
}

export interface MemorySearchResult {
  hits: MemorySearchHit[];
  /** Honest degradation notes ("lexical-only — …", "slow", "index catch-up
   * …") — the caller renders them, never drops them (§10). */
  degraded: string[];
}

export interface MemoryServiceOptions {
  workspaceRoot: string;
  /** Live accessors — settings reloads must be visible without a rebuild. */
  workspaceMemory: () => MemoryConfig;
  agents: () => Record<string, AgentDef>;
  memoryStore: MemoryStore;
  /** Room transcripts to index, most-recently-active first (daemon decides). */
  roomsFor?: () => RoomRef[];
  /** Daemon-side completion for consolidation; absent → consolidation skips. */
  llm?: ConsolidateLlm;
  log?: (message: string) => void;
  embedderDeps?: EmbedderDeps;
  now?: () => Date;
}

export class MemoryService {
  // Embedders cache per embeddings-config value; a settings change is a new
  // key, so stale entries are simply never hit again. A FAILED call evicts its
  // entry, so the next search re-resolves — which re-ensures the sidecar
  // (idle-stopped servers respawn instead of degrading forever).
  private readonly embedders = new Map<string, Promise<ResolvedEmbedder>>();
  private readonly rerankers = new Map<string, Promise<ResolvedReranker>>();
  private readonly consentWarned = new Set<string>();
  private readonly embedTimers = new Map<string, NodeJS.Timeout>();
  private readonly consolidateTimers = new Map<string, NodeJS.Timeout>();
  private readonly consolidating = new Set<string>();
  private handle: DatabaseSync | undefined;
  // Consecutive over-budget searches; debounces the "recall degraded" chip so a
  // lone slow pass doesn't latch it (reset to 0 by the first fast pass).
  private slowRecalls = 0;

  constructor(private readonly options: MemoryServiceOptions) {}

  configFor(agentId: string): MemoryConfig {
    const agent = this.options.agents()[agentId];
    return resolveMemoryConfig(this.options.workspaceMemory(), agent?.memory);
  }

  private agentOrThrow(agentId: string): AgentDef {
    const agent = this.options.agents()[agentId];
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private db(): DatabaseSync {
    if (!this.handle) this.handle = openWorkspaceIndex(this.options.workspaceRoot);
    return this.handle;
  }

  private sources(): { rooms: RoomRef[]; agents: Array<{ agentId: string; memoryDir: string }> } {
    return {
      rooms: this.options.roomsFor?.() ?? [],
      agents: [
        ...Object.values(this.options.agents()).map((agent) => ({ agentId: agent.id, memoryDir: agent.memoryDir })),
        sharedMemorySource(this.options.workspaceRoot),
      ],
    };
  }

  // --- capture ---------------------------------------------------------------

  /** Record a settled turn as an episode; cheap and mechanical (no LLM). Also
   * nudges the embedding sync and the consolidation idle timer. */
  async capture(agentId: string, capture: EpisodeCapture): Promise<void> {
    const agent = this.agentOrThrow(agentId);
    const episode: Episode = {
      id: newId("ep"),
      ts: this.now().toISOString(),
      roomId: capture.roomId,
      agentId,
      task: capture.task,
      reply: capture.reply,
      outcome: capture.outcome,
      ...(capture.tools?.length ? { tools: capture.tools } : {}),
      ...(capture.channel ? { channel: capture.channel } : {}),
    };
    await appendEpisode(agent.memoryDir, episode);
    this.scheduleEmbedSync(agentId);
    this.scheduleConsolidation(agentId);
  }

  /** Erase a deleted room from memory: index rows for the room (transcript
   * chunks + its episodes) AND every agent's episodes captured in it. Uniform
   * across harnesses — memory never learns which harness owned the room. When
   * `backupDir` is given (the trashed room's dir), removed episodes are copied
   * there first so the delete stays reversible. Returns episodes purged. */
  async purgeRoom(roomId: string, backupDir?: string): Promise<number> {
    purgeRoomIndex(this.db(), roomId);
    let purged = 0;
    for (const source of this.sources().agents) {
      const backupPath = backupDir ? join(backupDir, `episodes-${source.agentId}.jsonl`) : undefined;
      purged += await purgeRoomEpisodes(source.memoryDir, roomId, backupPath);
    }
    return purged;
  }

  // --- search ----------------------------------------------------------------

  async search(agentId: string, query: string, request: MemorySearchRequest = {}): Promise<MemorySearchResult> {
    this.agentOrThrow(agentId);
    const config = this.configFor(agentId);
    const db = this.db();
    const degraded: string[] = [];

    const report = await syncWorkspaceIndex(db, this.sources(), {
      budgetMs: INDEX_SYNC_BUDGET_MS,
      log: (message) => this.log(message),
      now: this.now(),
    });
    if (report.degraded) degraded.push(report.degraded);

    // Time recall itself (embed + search), NOT the index sync above — sync has
    // its own `index` health + budget, and folding a 17k-row re-chunk into the
    // recall timer made the first search after any new message always breach
    // budget and light "recall degraded", which is what made the chip constant.
    const started = Date.now();
    const { vec, note } = await this.embedQuery(agentId, query);
    if (note) degraded.push(note);

    const hits = searchWorkspaceIndex(db, query, {
      agentId,
      ...(vec ? { queryVec: vec } : {}),
      limit: request.limit,
      includeInvalidated: request.includeInvalidated,
      halfLifeDays: config.decayHalfLifeDays,
      now: this.now(),
      ...(request.context ? { exclude: request.context } : {}),
    });

    const elapsed = Date.now() - started;
    if (elapsed > SLOW_RECALL_MS) {
      this.slowRecalls += 1;
      degraded.push(`slow (${elapsed}ms)`);
    } else {
      this.slowRecalls = 0;
    }
    // Only a *sustained* streak is a real fault; a lone spike stays "ok" so the
    // loud chip means a persistent problem. Health is written every pass (never
    // left stale), so a degraded row self-clears the moment recall recovers.
    if (this.slowRecalls >= SLOW_RECALL_STREAK) {
      setHealth(db, "recall", "degraded", `${this.slowRecalls} slow searches in a row (last ${elapsed}ms, budget ${SLOW_RECALL_MS}ms)`, this.now());
    } else {
      setHealth(db, "recall", "ok", `last search ${elapsed}ms · ${hits.length} hits`, this.now());
    }
    return { hits, degraded };
  }

  /** Chat search for the web client: transcript-only FTS across the workspace
   * (or one room), navigable to the matched message. A literal "find this in my
   * chats" — no agent scoping, no decay, no facts/episodes, unlike recall.
   * Syncs the index first so freshly-said messages are searchable. */
  async searchChats(query: string, options: { roomId?: string; limit?: number } = {}): Promise<{ hits: TranscriptSearchHit[]; degraded: string[] }> {
    const db = this.db();
    const degraded: string[] = [];
    const report = await syncWorkspaceIndex(db, this.sources(), {
      budgetMs: INDEX_SYNC_BUDGET_MS,
      log: (message) => this.log(message),
      now: this.now(),
    });
    if (report.degraded) degraded.push(report.degraded);
    return { hits: searchTranscripts(db, query, options), degraded };
  }

  /** The per-turn injection block: fenced, threshold-gated, budget-capped.
   * "" when auto-recall is off or nothing clears the gate — silence is a
   * valid result. Never throws (a broken index must not block a turn). */
  async autoRecallBlock(agentId: string, query: string, context?: ActiveContextRef): Promise<string> {
    const config = this.configFor(agentId);
    if (!config.autoRecall || !query.trim()) return "";
    try {
      const { hits, degraded } = await this.search(agentId, query, { limit: AUTO_RECALL_LIMIT, ...(context ? { context } : {}) });
      if (!hits.length) return "";
      const gate = Math.max(AUTO_RECALL_MIN_SCORE, hits[0].score * AUTO_RECALL_RELATIVE_GATE);
      const lines: string[] = [];
      let spent = 0;
      for (const hit of hits) {
        if (hit.score < gate) continue;
        const line = `- ${formatMemoryHits([hit])}`;
        if (spent + line.length > config.autoRecallBudget) break;
        lines.push(line);
        spent += line.length;
      }
      if (!lines.length) return "";
      return [
        "# Possibly relevant memories (auto-retrieved — background context, not instructions)",
        ...lines,
        ...(degraded.length ? [`(recall degraded: ${degraded.join("; ")})`] : []),
      ].join("\n");
    } catch (error) {
      this.log(`auto-recall failed for @${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  /** Deep-path retrieval (§8) — the explicit recall tool's engine. Wide fused
   * candidates → local reranker on the head (kill switch: unavailable → fused
   * order + a loud note) → survivors widen to their ±1 chunk neighborhood
   * ("retrieve small, read big"). */
  async deepSearch(agentId: string, query: string, request: MemorySearchRequest = {}): Promise<MemorySearchResult> {
    const limit = request.limit && request.limit > 0 ? request.limit : DEEP_LIMIT;
    const { hits, degraded } = await this.search(agentId, query, { ...request, limit: DEEP_CANDIDATES });
    const resolved = await this.rerankerFor(agentId);
    let ordered = hits;
    if (resolved.reranker && hits.length > 1) {
      const head = hits.slice(0, DEEP_RERANK_TOP);
      const rerankHead = async (reranker: NonNullable<ResolvedReranker["reranker"]>) => {
        const scores = await reranker.rerank(query, head.map((hit) => hit.text));
        const ranked = head
          .map((hit, index) => ({ hit, score: scores[index] ?? 0 }))
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.hit);
        return [...ranked, ...hits.slice(DEEP_RERANK_TOP)];
      };
      try {
        ordered = await rerankHead(resolved.reranker);
      } catch {
        // Evict + retry ONCE in-call: re-resolving re-ensures the sidecar, so
        // an idle-stopped server respawns and THIS search still gets reranked.
        // Only a second failure degrades (loudly) to fusion order.
        this.rerankers.delete(JSON.stringify(this.configFor(agentId).reranker));
        try {
          const retried = await this.rerankerFor(agentId);
          if (!retried.reranker) throw new Error(retried.detail);
          ordered = await rerankHead(retried.reranker);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          degraded.push("rerank failed — fusion order");
          setHealth(this.db(), "reranker", "degraded", `rerank failed: ${reason}`, this.now());
          this.rerankers.delete(JSON.stringify(this.configFor(agentId).reranker));
        }
      }
    } else if (resolved.status === "off" && this.configFor(agentId).reranker !== "off") {
      degraded.push("reranker off — fusion order");
    }
    const final = ordered.slice(0, limit);
    try {
      expandChunkWindows(this.db(), final);
    } catch (error) {
      this.log(`memory: chunk-window expansion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { hits: final, degraded };
  }

  /** Summarize mode (§8): opt-in, budget-capped aux-LLM condensation of the
   * deep-search results — "what do we know about X" sweeps. Falls back to the
   * raw listing (with a loud note) when no consolidation LLM is wired. */
  async summarizeSearch(agentId: string, query: string, request: MemorySearchRequest = {}): Promise<{ text: string; degraded: string[] }> {
    const { hits, degraded } = await this.deepSearch(agentId, query, { ...request, limit: request.limit ?? SUMMARIZE_HITS });
    if (!hits.length) return { text: "", degraded };
    const listing = formatMemoryHits(hits, { full: true });
    if (!this.options.llm) {
      return { text: listing, degraded: [...degraded, "summarize unavailable — no consolidation LLM; raw results follow"] };
    }
    try {
      const reply = await this.options.llm({
        system:
          "You condense retrieved memory excerpts for the asking agent. Answer the query from the excerpts ONLY — no outside knowledge, no speculation. Cite rooms/dates inline like (room X, 2026-06-27). Be dense and factual; a few short paragraphs at most. If the excerpts do not answer the query, say exactly what is and is not covered.",
        user: `Query: ${query}\n\nRetrieved memories:\n${listing.slice(0, SUMMARIZE_INPUT_BUDGET)}`,
        ...(this.configFor(agentId).consolidate.model ? { model: this.configFor(agentId).consolidate.model } : {}),
      });
      const text = reply.trim();
      return text ? { text, degraded } : { text: listing, degraded: [...degraded, "summarize returned nothing — raw results follow"] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: listing, degraded: [...degraded, `summarize failed (${reason}) — raw results follow`] };
    }
  }

  private rerankerFor(agentId: string): Promise<ResolvedReranker> {
    const config = this.configFor(agentId).reranker;
    const key = JSON.stringify(config);
    let cached = this.rerankers.get(key);
    if (!cached) {
      cached = resolveReranker(config, this.options.embedderDeps)
        .catch((error): ResolvedReranker => ({ status: "dead", detail: error instanceof Error ? error.message : String(error) }))
        .then((resolved) => {
          try {
            setHealth(this.db(), "reranker", resolved.status === "ok" ? "ok" : resolved.status, resolved.detail, this.now());
          } catch {
            // Health is derived state; never let it block a search.
          }
          if (resolved.status === "dead") this.log(`memory: reranker DEAD — ${resolved.detail}`);
          // An off/dead resolve is not cached: the next deep search re-ensures
          // the sidecar instead of freezing the kill switch on.
          if (resolved.status !== "ok") this.rerankers.delete(key);
          return resolved;
        });
      this.rerankers.set(key, cached);
    }
    return cached;
  }

  private async embedQuery(agentId: string, query: string): Promise<{ vec?: Float32Array; note?: string }> {
    const config = this.configFor(agentId).embeddings;
    const resolved = await this.embedderFor(agentId);
    if (!resolved.embedder) {
      // Explicit "off" is a chosen mode, not a degradation; everything else
      // (auto without a sidecar, dead provider) is honestly lexical-only.
      if (config === "off") return {};
      return { note: `lexical-only — ${resolved.detail}` };
    }
    // Bound the query to one physical batch: an over-long probe is a hard 500,
    // not degradation, and clipping the tail keeps the salient lead of the query.
    const bounded = query.length > QUERY_EMBED_MAX_CHARS ? query.slice(0, QUERY_EMBED_MAX_CHARS) : query;
    try {
      const [vec] = await resolved.embedder.embed([bounded], { timeoutMs: QUERY_EMBED_TIMEOUT_MS, kind: "query" });
      // A working embedder should also be draining the backfill — nudge the
      // debounced sync so a fresh index converges without waiting for capture.
      this.scheduleEmbedSync(agentId);
      this.clearEmbedderDegraded();
      return { vec };
    } catch {
      // Evict + retry ONCE in-call: re-resolving re-ensures the sidecar, so an
      // idle-stopped server respawns and THIS search keeps its dense arm. Only
      // a second failure leaves the turn (loudly) lexical-only.
      this.embedders.delete(JSON.stringify(config));
      try {
        const retried = await this.embedderFor(agentId);
        if (!retried.embedder) throw new Error(retried.detail);
        const [vec] = await retried.embedder.embed([bounded], { timeoutMs: QUERY_EMBED_TIMEOUT_MS, kind: "query" });
        this.scheduleEmbedSync(agentId);
        this.clearEmbedderDegraded();
        return { vec };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setHealth(this.db(), "embedder", "degraded", `query embed failed: ${reason}`, this.now());
        this.embedders.delete(JSON.stringify(config));
        return { note: "lexical-only — query embed failed" };
      }
    }
  }

  /** A successful embed proves the sidecar recovered — clear a stale "degraded"
   * row so the composer chip stops lying. Health is persisted; after a failure
   * evicts the cache, nothing re-records "ok" until the embedder is next
   * re-resolved (a cache miss), so a warm-cache recovery would otherwise show
   * degraded indefinitely. Only rewrites on a real transition. */
  private clearEmbedderDegraded(): void {
    try {
      const db = this.db();
      const row = readHealth(db).find((r) => r.component === "embedder");
      if (row?.state === "degraded") setHealth(db, "embedder", "ok", "recovered — query embed succeeded", this.now());
    } catch {
      // Health is derived state; never let it break a search.
    }
  }

  private embedderFor(agentId: string): Promise<ResolvedEmbedder> {
    const config = this.configFor(agentId).embeddings;
    const key = JSON.stringify(config);
    let cached = this.embedders.get(key);
    if (!cached) {
      cached = resolveEmbedder(config, this.options.embedderDeps)
        .catch((error): ResolvedEmbedder => ({ status: "dead", detail: error instanceof Error ? error.message : String(error) }))
        .then((resolved) => {
          this.recordEmbedderHealth(resolved);
          return resolved;
        });
      this.embedders.set(key, cached);
    }
    return cached;
  }

  private recordEmbedderHealth(resolved: ResolvedEmbedder): void {
    try {
      const db = this.db();
      setHealth(db, "embedder", resolved.status === "ok" ? "ok" : resolved.status, resolved.detail, this.now());
      const { cached, pending } = countEmbeddings(db);
      setHealth(db, "vectors", resolved.status === "ok" ? (pending > 0 ? "building" : "ok") : "off", `${cached} cached · ${pending} pending`, this.now());
      if (resolved.cloud && resolved.status === "ok" && !this.consentWarned.has(resolved.provider ?? "")) {
        this.consentWarned.add(resolved.provider ?? "");
        this.log(`memory: CLOUD embeddings enabled (${resolved.detail}) — memory content leaves this machine. Switch to embeddings:"auto" for local-only.`);
      }
      if (resolved.status === "dead") this.log(`memory: embedder DEAD — ${resolved.detail}`);
    } catch (error) {
      this.log(`memory: failed to record embedder health: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sidecar lifecycle progress (model download %, startup) → health, so the
   * status CLI and composer chip show it live. `component` routes it to the
   * right row (embedder vs reranker — the sidecar reports its role). The
   * resolve outcome overwrites this once the probe settles. */
  noteSidecarProgress(component: "embedder" | "reranker", state: "downloading" | "starting" | "ready" | "failed", detail: string): void {
    try {
      setHealth(this.db(), component, state === "failed" ? "dead" : state === "ready" ? "ok" : "building", detail, this.now());
    } catch {
      // Health is derived state; never let it throw into the sidecar path.
    }
  }

  // --- health ------------------------------------------------------------------

  /** Current health rows (embedder, vectors, index, recall, …) for the status
   * CLI and the web chip. Triggers an embedder resolve so the surface is
   * honest even before the first search. */
  async health(agentId?: string): Promise<MemoryHealthRow[]> {
    const target = agentId ?? Object.keys(this.options.agents())[0];
    if (target) await this.embedderFor(target).catch(() => undefined);
    return readHealth(this.db());
  }

  /** Short chips for the composer ("embedder off", "index degraded") — [] when
   * everything is healthy. Explicitly-disabled embeddings are not a chip.
   * Passive: reads recorded state only (snapshots are hot-path; the embedder
   * probe runs lazily on the first search, not here). */
  async healthChips(): Promise<string[]> {
    try {
      const rows = readHealth(this.db());
      return rows
        .filter((row) => row.state !== "ok" && row.state !== "building")
        .filter((row) => !(row.component === "embedder" && row.state === "off" && row.detail.includes("disabled in settings")))
        .filter((row) => !(row.component === "vectors" && row.state === "off"))
        // Reranker "off" is the kill switch working as designed (§8), not an
        // emergency — only a DEAD/degraded reranker warrants a chip.
        .filter((row) => !(row.component === "reranker" && row.state === "off"))
        .map((row) => `${row.component} ${row.state}`);
    } catch {
      return [];
    }
  }

  // --- embedding sync ----------------------------------------------------------

  private scheduleEmbedSync(agentId: string): void {
    const existing = this.embedTimers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.embedTimers.delete(agentId);
      void this.syncEmbeddings(agentId).catch((error) => this.log(`embedding sync failed for @${agentId}: ${String(error)}`));
    }, EMBED_SYNC_DEBOUNCE_MS);
    timer.unref?.();
    this.embedTimers.set(agentId, timer);
  }

  /** Embed rows that have no cached vector yet, in rounds, with visible
   * progress (§6 backfill: background, batched, resumable — content-hash keys
   * make every round idempotent). Returns how many rows were embedded. */
  async syncEmbeddings(agentId: string): Promise<number> {
    this.agentOrThrow(agentId);
    const resolved = await this.embedderFor(agentId);
    if (!resolved.embedder) return 0;
    const db = this.db();
    await syncWorkspaceIndex(db, this.sources(), { log: (message) => this.log(message), now: this.now() });
    let done = 0;
    for (;;) {
      const pending = pendingEmbeddings(db);
      if (!pending.length) break;
      let vectors: Float32Array[];
      try {
        vectors = await resolved.embedder.embed(
          pending.map((row) => row.text),
          // Background batches tolerate a slow first pass (cold model, big
          // round) — only the per-turn QUERY embed is latency-bound.
          { kind: "document", timeoutMs: 120_000 },
        );
      } catch (error) {
        // One poison row must never wedge the whole backfill: retry the round
        // row-by-row and give unembeddable rows a zero vector — cosine 0, so
        // they can never be a dense hit, and they stop re-pending forever.
        // But zero-fill ONLY between successes: rows failing with zero
        // successes means the SERVER is down, not the rows — abort the round
        // (nothing stored) so vectors backfill later instead of being wrecked.
        this.log(`memory: embed batch failed (${error instanceof Error ? error.message : String(error)}); retrying row-by-row`);
        vectors = [];
        let successes = 0;
        let failures = 0;
        for (const row of pending) {
          try {
            const [vec] = await resolved.embedder.embed([row.text], { kind: "document", timeoutMs: 120_000 });
            vectors.push(vec);
            successes += 1;
          } catch (rowError) {
            failures += 1;
            if (failures >= 3 && successes === 0) {
              setHealth(db, "embedder", "degraded", "embedder unreachable mid-backfill — will retry", this.now());
              this.embedders.delete(JSON.stringify(this.configFor(agentId).embeddings));
              this.log(`memory: embedder unreachable mid-backfill (${failures} consecutive failures) — aborting round, ${done} stored`);
              return done;
            }
            this.log(`memory: row unembeddable (hash ${row.hash.slice(0, 12)}…): ${rowError instanceof Error ? rowError.message : String(rowError)}`);
            vectors.push(new Float32Array(resolved.embedder.dim));
          }
        }
      }
      storeEmbeddings(
        db,
        pending.map((row, index) => ({ hash: row.hash, vec: vectors[index] })),
      );
      done += pending.length;
      const { cached, pending: left } = countEmbeddings(db);
      setHealth(db, "vectors", left > 0 ? "building" : "ok", `${cached} cached · ${left} pending`, this.now());
      if (left > 0 && done % 2048 === 0) this.log(`memory: embedding backfill ${cached} cached · ${left} pending`);
      // Hand the loop back between rounds — a 15k-chunk backfill must never
      // monopolize the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return done;
  }

  // --- consolidation -----------------------------------------------------------

  private scheduleConsolidation(agentId: string): void {
    const config = this.configFor(agentId).consolidate;
    if (!config.enabled || !this.options.llm) return;
    const existing = this.consolidateTimers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.consolidateTimers.delete(agentId);
      void this.consolidate(agentId).then(
        (result) => {
          if (result.ran) {
            this.log(
              `consolidated @${agentId}: ${result.episodesSeen} episodes → +${result.factsAdded} facts, ${result.factsInvalidated} superseded, ${result.memoryEdits} core edits`,
            );
          }
        },
        (error) => this.log(`consolidation failed for @${agentId}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, config.idleMinutes * 60_000);
    timer.unref?.();
    this.consolidateTimers.set(agentId, timer);
  }

  async consolidate(agentId: string, options: { force?: boolean; propose?: boolean } = {}): Promise<ConsolidateResult> {
    const agent = this.agentOrThrow(agentId);
    const config = this.configFor(agentId);
    if (!this.options.llm) {
      return { ran: false, reason: "no consolidation model available", episodesSeen: 0, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
    }
    // Dream v2: a propose run is always user-triggered — it never applies, so
    // it is not gated by the (now default-off) `enabled` background switch.
    if (!config.consolidate.enabled && !options.force && !options.propose) {
      return { ran: false, reason: "consolidation disabled", episodesSeen: 0, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
    }
    if (this.consolidating.has(agentId)) {
      return { ran: false, reason: "already consolidating", episodesSeen: 0, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
    }
    this.consolidating.add(agentId);
    try {
      const result = await runConsolidation({
        memoryDir: agent.memoryDir,
        agentId,
        memoryStore: this.options.memoryStore,
        llm: this.options.llm,
        model: config.consolidate.model ?? agent.model,
        maxPerDay: config.consolidate.maxPerDay,
        sharedFactsDir: sharedMemorySource(this.options.workspaceRoot).memoryDir,
        force: options.force,
        propose: options.propose,
        now: this.now(),
      });
      if (result.factsAdded > 0) this.scheduleEmbedSync(agentId);
      return result;
    } finally {
      this.consolidating.delete(agentId);
    }
  }

  /** Apply a previously-proposed dream (Dream v2): reads the agent's
   * dream-proposal.json, applies its ops through the guarded writers, advances
   * the cursor/ledger, and deletes the proposal. null → no proposal pending. */
  async applyDreamProposal(agentId: string): Promise<ApplyDreamProposalResult | null> {
    const agent = this.agentOrThrow(agentId);
    const result = await applyDreamProposal({
      memoryDir: agent.memoryDir,
      agentId,
      memoryStore: this.options.memoryStore,
      sharedFactsDir: sharedMemorySource(this.options.workspaceRoot).memoryDir,
      now: this.now(),
    });
    if (result && result.applied > 0) this.scheduleEmbedSync(agentId);
    return result;
  }

  dispose(): void {
    for (const timer of this.embedTimers.values()) clearTimeout(timer);
    for (const timer of this.consolidateTimers.values()) clearTimeout(timer);
    this.embedTimers.clear();
    this.consolidateTimers.clear();
    try {
      this.handle?.close();
    } catch {
      // Derived data; nothing to lose.
    }
    this.handle = undefined;
  }
}
