# MEMORY-DESIGN.md — GAIA Memory v4

v3 is archived at `docs/history/MEMORY-DESIGN-v3.md`. v4 exists because v3
failed in production in a way its design made possible: semantic recall died
silently (an invalid cloud key 401'd on every embed, forever, with no surface),
and the lexical fallback's ranking buried a real past conversation under
recent-self noise. The agent then honestly told the user "I don't find that
prior conversation" about a conversation sitting on disk. That incident is
reproduced, root-caused, and encoded below as regression eval #1.

Inputs to this design (2026-07-05):
- Post-mortem of the incident — 8 verified failure modes (§1).
- Source analysis of hermes-agent at HEAD `7fde19a` (fresh clone) + its live
  deployment, plus an online sweep of its provider ecosystem (§2).
- A verified SOTA survey: LongMemEval/LoCoMo/MemoryAgentBench reality,
  Mem0/Zep/Letta/HippoRAG-2/LightMem post-mortems, local embedding stack
  benchmarks, context-engineering consensus (§3).

Standing rules unchanged: no build step, minimal deps, memory is a daemon
service behind uniform surfaces (RULE #0 — no harness ever special-cased),
append-only plain files are the source of truth, every index is derived and
deletable, NO PROGRESS EVER LOST, simple by default with every knob in settings.

New rule, earned the hard way: **degradation must be loud.** Every fallback
sets visible state. A memory subsystem that silently gets worse is a bug class,
not a graceful fallback.

---

## 1. Why v3 failed — 8 failure modes, each mapped to a structural fix

| # | v3 failure (verified live) | v4 structural fix |
|---|---|---|
| 1 | **Silent semantic death.** `embeddings:"auto"` treated key-EXISTS as key-WORKS; an invalid OPENAI_API_KEY 401'd on every embed; 0 vectors ever cached; only trace was buried log lines | Probe-at-resolve (§6): one validation embed before a provider is trusted; failure marks it dead + sets a visible degraded state (§10). Silent fallback is impossible by construction |
| 2 | **Transcripts never embedded.** Vectors covered only facts+episodes; the user's actual history (14MB, ~10k events) was lexical-only even with a working key | The union store (§5): verbatim transcript chunks are first-class retrieval targets, embedded and FTS-indexed alongside facts and episodes |
| 3 | **Cross-room rank folding destroyed score information.** Per-room bm25 top-50 lists folded by RANK (RRF): every room's rank-0 tied at 1/60 regardless of match quality; with 105 rooms, recency decay decided the order | ONE global FTS corpus over all rooms (§5): a single bm25 ranking with global corpus statistics. Score magnitude survives; fusion is score-based, not rank-only (§7) |
| 4 | **Self-pollution.** The recall tool had no freshness filter; "did we discuss X?" retrieved the asking | CALMem predicate (§7): exclude hits already in the active context window; explicitly INCLUDE compacted-away content — recall's job is to reinstate what compaction evicted |
| 5 | **Persona silos.** @ari could not reach @nyari's distilled memory; the only shared surface was raw transcripts, the weakest-ranked layer | Two-scope facts (§5): workspace-shared facts (about the user/world, actor-attributed) + persona-private facts. Transcript chunks were always workspace-wide; now they rank properly |
| 6 | **Query degeneration.** OR-of-24-tokens; common tokens matched everything; rank folding discarded bm25's IDF work | Global bm25 keeps IDF meaningful (§5); dense retrieval carries paraphrase (§6); deep path adds a reranker that subsumes term-weighting cleverness (§8) |
| 7 | **Privacy conflict.** Only cloud embedding backends existed. Shipping this user's persona memory to OpenAI was never acceptable — the invalid key accidentally *prevented* an unwanted upload | Local-first stack (§6): llama.cpp sidecar on localhost, nothing leaves the machine. `auto` NEVER selects cloud; cloud is explicit opt-in with a "memory content leaves this machine" warning |
| 8 | **Recency was the only real tiebreaker** once scores flattened | Calibrated fusion with real score signal (§7); decay stays a soft multiplier (floor 0.25), never the decider |

Scale envelope: today 105 rooms / ~9.75k events / 14MB transcripts, ≤20 facts +
≤200 episodes per persona. Design target: 100× (≈1M events / 1.4GB) without
architectural change (§11 has the quantization ladder).

## 2. The competitive bar — Hermes, honestly stated

Hermes built-in (HEAD-verified) = pinned char-budgeted memory blocks
(MEMORY.md ~800 tok + USER.md ~500 tok) injected as a **frozen snapshot**
(prefix-cache stability) + FTS5/bm25 `session_search` over the full transcript
DB with query-time aux-LLM summarization. **Zero vectors in the built-in path.**
Semantic memory exists only as opt-in third-party plugins (Mem0, Honcho,
Hindsight, Supermemory, …) that bolt onto — and fight with — the un-disableable
built-in store. Vendor recommends none; the typical deployment runs none.
Its two documented ecosystem diseases: **dual-write pollution** (built-in store
fights the provider for writes) and **silent provider fallback** (provider dies,
built-in takes over, nobody told). GAIA v4 is a single-writer, single-engine
design with loud health — those failure modes don't structurally exist here.

Adopted from Hermes (they earned these):
- **Frozen-snapshot pinned tier** — byte-stable prompt prefix per session (§9).
- **Non-destructive compaction** — compacted-away content stays indexed and
  recallable (their `messages.active` soft-tombstone; our transcripts are
  already append-only — v4 makes recall's exclusion predicate compaction-aware).
- **Atomic batch memory writes** validated against the FINAL budget (§5).
- **Memory-failure circuit breaker** — a memory side-effect that can't succeed
  must never block the turn's reply (§5).
- **Snapshot-time poison scanning** — a compromised on-disk entry becomes
  `[BLOCKED: …]` in the prompt while staying user-visible on disk (§9).
- **Scroll mode** — a no-LLM raw pager around any recall hit (§8).
- **60-char description discipline** for always-injected indexes (§9).

Where v4 goes past them: local semantic recall by default, bi-temporal validity,
global hybrid ranking, self-match exclusion, health as first-class state, and
an in-house eval harness over the user's own history.

## 3. What the field settled in 2026 (and what we refuse)

Must-haves this design implements (benchmark-backed; see the research report):
1. **Union store** — verbatim chunks + extracted facts, both retrievable.
   Verbatim beats extraction-only by +15.9–22pp (arXiv:2601.00821); facts
   augment as keys/summaries, never replace raw text.
2. **Absolute bi-temporal timestamps** on every memory, "as of \<date\>"
   rendering, supersede-never-delete (the most consistent cross-benchmark win;
   temporal QA collapses without it).
3. **Hybrid BM25 ∪ dense in one SQLite** with entity/speaker/time as ranking
   signals — not an LLM-built knowledge graph.
4. **Small local reranker on the deep path** (subsumes fancier structure —
   arXiv:2606.28367; Anthropic contextual-retrieval −67% failures).
5. **Tiny injection with threshold + first-class empty recall** — a focused
   ~300-token injection beat a 113k-token full history on every model family
   (Chroma context-rot); distractors measurably hurt (MemConflict).
6. **Self-match exclusion, compaction-aware** (CALMem predicate).
7. **Speaker attribution + user-fact/agent-inference segregation** — agents
   laundering guesses into "facts" drives up-to-25× sycophancy amplification
   (Writer, ICLR 2026).
8. **Sleep-time consolidation from raw transcripts only**, write-gated.
9. **Never re-ingest injected recall** (Mem0's 808-copies feedback loop).
10. **KV-cache-stable layout** — pinned blocks byte-stable; recall rides the
    turn input, never the cached system prefix (v3 already did this; kept).

Refused (traps with receipts):
- **LLM-built knowledge graphs** (Mem0^g +2%; Zep loses its own knowledge-update
  category to full-context; GraphRAG 7–12× index cost, loses factual QA).
- **LLM writes on the hot path** (97.8% junk at scale, 20,000× BM25 write cost).
- **Extraction-only memory** (irreversible loss + sycophancy amplification).
- **Hard decay/forgetting** (absent from every 2026 winner; we keep soft decay
  as a ranking prior only, floor 0.25).
- **Leaderboard chasing** (LoCoMo's key is 6.4% wrong; judge accepts 63% of
  wrong answers; every cross-vendor number is disputed). We eval on the user's
  own transcripts instead (§12).
- **Cloud-by-default anything.**

## 4. Architecture at a glance

```
                    SOURCE OF TRUTH (plain files, append-only)
  per agent:   MEMORY.md USER.md *.md   facts.jsonl   episodes.jsonl
  per workspace:                 shared-facts.jsonl   rooms/*/transcript.jsonl
                                      │
                                      ▼ incremental cursors (mtime/line/op)
                    ONE DERIVED INDEX per workspace
  <workspace>/.gaia/memory/index.db (node:sqlite; delete = rebuild)
    chunks + chunks_fts        ← transcript chunks, ALL rooms, global bm25
    facts + facts_fts          ← both scopes, bi-temporal columns
    episodes + episodes_fts
    embeddings(hash → int8 vec, dim-truncated)   ← chunks ∪ facts ∪ episodes
    health(component → state, detail, ts)        ← §10
                                      │
              ┌───────────────────────┴───────────────────────┐
              ▼ FAST PATH (every turn, ≤150ms p50)             ▼ DEEP PATH (recall tool)
  bm25 top-50 ∪ dense top-50                       fast-path candidates (wider)
  → calibrated fusion + signals                    → local reranker top-20
  → self-match exclusion                           → expand hit → chunk/session context
  → threshold gate, ≤5 lines, empty OK             → modes: search | scroll | summarize
              │                                                │
              ▼                                                ▼
  turn-input overlay (never the system prefix)      tool result to the agent
```

Embedding + rerank models run in a daemon-managed **llama.cpp sidecar** on
localhost (`llama-server` — already on this machine via Homebrew). Nothing
leaves the machine. RULE #0 holds throughout: everything above is daemon-side;
harnesses see the same `gaia recall` CLI, HTTP bridge, and turn-overlay they
see today.

## 5. Storage

**Unchanged:** per-agent `memoryDir` with core MD files (human-editable, capped),
`facts.jsonl` (append-only op log: add/invalidate, bi-temporal `validFrom`/
`validTo`/`supersededBy`, provenance enum), `episodes.jsonl` (mechanical
post-commit capture of settled turns — task, reply, outcome, tools, channel).
Room transcripts stay the verbatim ground truth; they are already append-only
and never destroyed (compaction is a context-window event, not a data event).

**New — two-scope facts.** Facts carry `scope: "agent" | "workspace"` and
`actor` (who stated/learned it: `user:<name>` or `agent:<id>`). Workspace-scope
facts live in `<workspace>/.gaia/memory/shared/facts.jsonl` — one shared,
actor-attributed store for facts about the user and the world, readable by
every persona's recall. Persona-relational facts (an agent's private notes)
stay agent-scope in its own memoryDir. The consolidator decides scope with
explicit guidance: *user-stated facts about the user → workspace; the persona's
own interpretations and relationship state → agent.* `source: "user_stated"`
facts are never rewritten by consolidation — user words outrank agent
inference, mechanically (fix for failure #5, and must-have #7).

**New — transcript chunks.** The index maintains verbatim chunks over every
room transcript: contiguous events, split on turn boundaries, target 600–1000
chars, carrying `(roomId, eventIds[], tsFrom, tsTo, speakers[])`. Chunks are
derived (rebuildable from transcripts) but first-class in retrieval — the
union-store principle. This also kills v3's useless 48-char snippets: a hit
renders as a real attributed excerpt.

**New — write hardening on the memory tool** (uniform, all harnesses):
- **Atomic batch ops**: `operations: [{add|replace|remove}, …]` validated
  against the final budget, committed under one lock — ends the multi-turn
  consolidate-retry dance that re-sends context.
- **Circuit breaker**: after N at-capacity failures in one turn, return a
  terminal "stop — answer the user" result. A memory side-effect never blocks
  a reply.
- **Drift detection**: replace/remove against a file edited out-of-band →
  snapshot `.bak`, reload, retry-or-report; appends skip the guard.
- **Write scan**: the existing secret filter plus prompt-injection patterns
  (both at write time and at snapshot build, §9).

## 6. Embeddings — local, verified, quantized

**Provider table** (data, not branches) gains a `local` kind:

| provider | kind | transport | default model |
|---|---|---|---|
| `local` (default) | llama.cpp sidecar | OpenAI-compat `/v1/embeddings` on 127.0.0.1 | EmbeddingGemma-300m (Q8, ~300MB) |
| `openai`, `gemini` | cloud | as today | **opt-in only**, with an explicit "memory content leaves this machine" consent warning |

- `embeddings: "auto"` resolves **local → off**. It never selects cloud. (The
  v3 semantics — auto-pick any cloud key lying around in the environment — are
  gone; that's how failure #7 almost shipped intimate memory to OpenAI.)
- **Sidecar lifecycle**, managed by the daemon like the voice engines: model
  pulled once into `~/.gaia/cache/models/` (with checksum), `llama-server`
  spawned on demand on a private port, idle-shutdown after N minutes, health
  probed. `llama-server` is already installed here; the daemon can also manage
  its own pinned binary. M1 Pro/16GB envelope: ~300–700MB resident while hot.
- **Probe-at-resolve**: before any provider is trusted, embed one probe text.
  Auth failure, wrong dim, timeout → provider marked `dead` in health state
  (§10) and the resolver moves on. An invalid key can never again masquerade
  as a working embedder (failure #1).
- **Quantization ladder**: vectors stored int8 at MRL-truncated 256d
  (EmbeddingGemma loses ~2% at 256d). Brute-force int8 scan is <10ms to ~50k
  vectors — covers 5× today's corpus. Past that, add a binary coarse pass
  (Hamming) → exact rescore of top-K. Past ~500k, `sqlite-vec` as an optional
  loadable extension. Same DB file throughout; no vector database, ever.
- Model choice is a setting: `Qwen3-Embedding-0.6B` (~640MB) for the quality
  ceiling; EmbeddingGemma default for the size/quality knee. Apple NLEmbedding
  was measured on this machine and disqualified (paraphrase/unrelated
  separation 0.345 vs 0.280 — noise).
- Backfill: embedding sync is background + debounced (kept from v3), now
  covering chunks; progress visible in health (`vectors: cached/pending`).

## 7. Fast-path retrieval (auto-recall, every turn)

1. **Lexical**: one FTS5 query over the global corpus (chunks ∪ facts ∪
   episodes tables share bm25 statistics per table but rank in one candidate
   pool with per-table score normalization). Term prep keeps v3's dedupe/cap
   hygiene; IDF does the weighting work now that statistics are global
   (failures #3, #6).
2. **Dense**: query embed via sidecar (1–5ms, 800ms timeout → lexical-only +
   `degraded` health flag, never a blocked turn), int8 cosine scan, top-50.
3. **Fusion**: min-max normalize each list, convex combine
   (`α·dense + (1−α)·lexical`, α=0.5 default, tunable via eval §12 — beats
   plain RRF with even a handful of labeled examples). Then multiply by soft
   signals: provenance weight (`user_stated 1.2 · outcome_verified 1.15 ·
   agent_inferred 1.0 · consolidator 0.9`), recency decay (half-life 60d,
   **floor 0.25**), small log-scaled access boost. Decay tunes, never decides.
4. **Self-match exclusion (CALMem)**: drop any hit whose source events are in
   the current room's **active context window** (the daemon knows the context
   gate cursor). Explicitly KEEP hits from the same room that compaction has
   evicted — recall's job is reinstatement, not duplication (failure #4).
5. **Gate + budget**: score threshold relative to top hit + absolute floor
   (kept from v3), dedup near-identical texts, ≤5 lines, default ≤600 tokens
   (configurable; the research's sweet spot is a focused few hundred). Lines
   render with absolute dates + attribution:
   `- [2026-06-27 · room youtube-thumbnail-critique · @user said] …excerpt…`
   Empty recall injects nothing. Silence is a valid result.
6. **Placement**: the block stays a turn-input overlay (v3 got this right) —
   fenced, marked non-instructional AND non-extractable (§9's capture path
   strips it structurally — must-have #9).

Latency contract: p50 ≤150ms, p99 ≤1s hard budget; on overrun, return what's
found, set `degraded: slow`, never block the turn. Baseline to beat: v3's
105-DB per-query scan measured 100–312ms; one warm index should sit well
under that.

## 8. Deep-path retrieval (the recall tool)

Same engine, more spend — explicitly invoked, so latency tolerance is seconds:
- **search** (default): fast-path candidates (wider: top-100) → local
  **reranker** (Qwen3-Reranker-0.6B via the same sidecar, `/v1/rerank`) on the
  top-20 → "retrieve small, read big": each surviving hit expands to its
  neighboring chunk window (±1 chunk) before rendering. ~150–400ms rerank cost.
- **scroll**: `--around <hitId>` pages the raw transcript window around any
  previous hit, forward/back — a no-LLM pager (Hermes's best UX idea).
- **summarize**: opt-in, budget-capped aux-LLM condensation of the top-N
  matched conversations (the consolidation model, local/cheap by default) —
  for "what do we know about X" sweeps, never on by default.
- Kill switch honored: reranker unavailable → search still works (fusion order),
  health shows `reranker: off`.

The tool's verb and wire surface (`gaia recall`, HTTP bridge) are unchanged —
existing harness wiring keeps working (RULE #0: zero per-harness edits).

## 9. Injection & the pinned tier — KV-cache discipline

- **Pinned tier** (core MD files): the goal is cache discipline — the block
  must never invalidate the provider prefix cache mid-session. GAIA's existing
  mechanism already achieves this and strictly dominates Hermes's freeze: the
  memory block rides the TURN INPUT (not the cached system prefix) and is
  re-sent only when its bytes change (`memoryChanged`), so prior turns stay
  cached AND mid-session writes surface on the very next turn. Kept as-is;
  the "frozen until next session" compromise is unnecessary here.
- **Snapshot-time poison scan**: entries matching injection/exfil patterns
  render as `[BLOCKED: flagged entry — review in settings]` in the snapshot
  while the on-disk text stays visible to the user. Deterministic from disk
  bytes, so the frozen-snapshot invariant holds.
- **Budgets tightened**: default core caps drop toward Hermes parity
  (MEMORY.md ~800 tok, USER.md ~500 tok equivalent in chars; configurable).
  Today's ~5KB core buys less than a disciplined 3.5KB — the eval (§12)
  arbitrates any further tightening. Any always-injected index line (skills,
  tools, memory headers) obeys a hard 60-char description budget.
- **Capture hygiene**: episode capture and consolidation input are built from
  the RAW transcript with recall overlays and fenced injected blocks
  structurally stripped — injected recall can never be re-ingested (the
  808-copies loop is impossible by construction, not by prompt-politeness).

## 10. Health — degradation is loud

A `health` table + one uniform surface:
- `gaia memory status` (CLI) and a settings/status panel chip (web) showing:
  embedder (provider/model/probe result/last error), vectors cached vs pending,
  index freshness per source, reranker state, last consolidation run, current
  degradation flags (`lexical-only`, `slow`, `probe-failed`, `budget-cut`).
- Any degraded flag renders a visible warning chip in the composer (same
  pattern as the model-fallback warning) — the user finds out at a glance,
  not from a buried log line.
- Recall results themselves carry an honest header when degraded:
  `(recall: lexical-only — local embedder offline)` — the agent sees it too
  and can say so instead of confabulating certainty.
- Log lines remain (for post-mortems), but they are never the only signal.

## 11. Performance contract

| operation | budget | mechanism |
|---|---|---|
| auto-recall (hot path) | p50 ≤150ms · p99 ≤1s hard | one warm index, int8 scan, no LLM, fail-soft |
| query embed | ≤5ms local · 800ms timeout | sidecar, Metal; timeout → lexical-only + flag |
| deep recall w/ rerank | ≤2s | explicit call; reranker top-20 only |
| index catch-up per turn | ≤30ms typical | incremental cursors (append-only sources) |
| embedding backfill | background | debounced, batched, idle-friendly, resumable |
| turn overhead (tokens) | core ≤~1.3k + recall ≤600, both configurable | caps enforced at write/injection time |
| memory of the daemon | sidecar ~300–700MB only while hot | idle shutdown |

Scan-budget + event-loop yields (v3's recall-freeze fix) carry over wherever a
scan can exceed its budget; the difference is that a budget cut now sets a
visible flag instead of silently shrinking coverage.

## 12. Eval — the user's own history is the benchmark

`gaia memory eval`: a YAML set of (query → expected evidence) probes run
against the live index, reporting hit@k / MRR / injected-token cost per run,
before/after any retrieval change. Seeded with real cases from this
workspace's history — **eval #1 is the incident**: a paraphrase query about
the June Iran/Palantir conversations must surface the right rooms in the top 5
with zero literal keyword overlap required. Public-benchmark numbers are
explicitly out of scope (LoCoMo's answer key is 6.4% wrong and every
cross-vendor number in the field is disputed); within-harness ablation on the
user's own data is the only score that matters here.

## 13. Consolidation (sleep-time) — kept, hardened

Kept from v3: debounced idle trigger, daily cap, circuit breaker, ops through
`MemoryStore.mutate` (caps + secret filter), supersede-never-delete,
`source:"consolidator"` ranked below user-stated, near-dup drop (cosine>0.95),
"no ops" as a first-class outcome. Hardened:
- Input is raw transcript slices ONLY — never prior summaries, never recall
  blocks (structurally stripped, §9). No summaries-of-summaries drift.
- Scope-aware output: user facts → workspace store; persona-relational →
  agent store (§5). `user_stated` facts are immutable to the consolidator
  (it may supersede with a new fact, never rewrite in place).
- Runs on the configured aux model — local/cheap by default, and OFF is a
  respectable setting (Hermes shipped consolidation default-off for cost;
  we keep it on-idle but cheap, and the eval shows whether it pays).

## 14. Migration from v3

- Source files are forward-compatible: `facts.jsonl` gains optional `scope`/
  `actor` fields (absent = `agent`-scope, actor unknown); `episodes.jsonl`
  unchanged; core MD files unchanged.
- `index.db` (per-agent) and per-room `recall.db` are derived → deleted; the
  new workspace `index.db` builds incrementally from files on first use. The
  per-room transcript FTS (`recall.db`) retires — the bare-CLI recall fallback
  reads the workspace index instead.
- Config: `memory.embeddings` keeps its shape; `"auto"` now means local-first
  (never cloud). An existing explicit cloud config keeps working but triggers
  the consent warning once.
- Nothing about rooms, turn WAL, or the durable queue changes.

## 15. Implementation phases

1. **P1 — unified index + honest lexical.** Workspace index.db; transcript
   chunks; global bm25; score-based fusion scaffolding (lexical-only);
   self-match exclusion; threshold+budget; health table + status surface +
   composer chip; eval harness with eval #1. *This alone fixes the incident's
   lexical half and makes any remaining weakness visible.*
2. **P2 — local semantics.** Sidecar lifecycle (llama-server), probe-at-resolve,
   EmbeddingGemma default, int8/256d storage, dense arm + calibrated fusion,
   backfill with visible progress. *Paraphrase recall lands here — eval #1
   must pass with zero keyword overlap.*
3. **P3 — deep path.** Reranker stage, scroll + summarize modes, chunk-window
   expansion.
4. **P4 — write path + scopes.** Batch ops, breaker, drift detection, poison
   scan (write + snapshot), frozen-snapshot pinned tier, workspace-shared
   facts, consolidation hardening, budget tightening per eval.

Each phase ships green (`npm run check` + tests + eval) and independently
improves the live system; no phase depends on a later one.
