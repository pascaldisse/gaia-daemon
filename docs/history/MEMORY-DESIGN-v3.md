# MEMORY-DESIGN.md — GAIA memory v3

The research (2026-07): the agent-memory field converged on five techniques that
actually move quality, and a long list that doesn't. This design adopts the five,
skips the hype, and keeps GAIA's rules: no build step, no new dependencies,
harness-uniform (memory is a daemon service — no harness ever special-cased),
simple by default with every knob in settings, and NO PROGRESS EVER LOST
(source of truth is append-only plain files; every index is derived and
rebuildable).

## What the evidence says

Adopted (strong evidence):

1. **Distilled, dated, self-contained facts** beat raw-chunk RAG. Every top
   LongMemEval system retrieves extracted dated fact sentences, not transcript
   chunks.
2. **Background consolidation** ("sleep-time compute", Letta's sleep agents,
   Hermes's review fork). Runs off the hot path,
   debounced on idle, loop-protected, capped.
3. **Bi-temporal facts: supersede, never delete.** Zep's temporal/knowledge-update
   wins come from `validFrom`/`validTo`/`supersededBy` columns, not the graph.
4. **Hybrid lexical+vector retrieval with RRF fusion.** BM25 alone embarrasses
   most commercial systems; embeddings add paraphrase recall; RRF fuses them
   with no LLM in the query path (sub-second, deterministic).
5. **Small, hard-budgeted, always-injected core memory** with overflow-forced
   consolidation. We already have this (MEMORY.md 4K / USER.md 2K) — the cap IS
   the feature.

Rejected (evidence against, at personal scale):

- Knowledge graphs (Mem0 removed theirs from OSS; Zep's real retrieval context
  is flat fact sentences). Substitute: an `entities` tag column as a ranking
  boost.
- LLM importance scoring at write time (never validated). Substitute: recency ×
  provenance × access-count, all measured.
- Per-turn hot-path memory writes by the main agent (Letta's own retreat).
  Hot path is read-only except explicit memory-tool calls.
- Fixed-k retrieval (benchmark overfit). Score-threshold gating instead.
- Six-plus memory-type taxonomies. Exactly four kinds: core / semantic /
  episodic / procedural.

Where this beats Hermes (the direct comparison target): Hermes has no
embeddings (paraphrase queries fail), a frozen-per-session core snapshot (ours
refreshes per turn via `memoryChanged` diffing — already shipped), no temporal
model, and complexity-triggered rather than outcome-grounded reflection. We
match its strengths (budgeted core, FTS episodic, background review, write
security) and exceed on all four gaps.

## Storage — source of truth is plain files

Everything lives in the agent's existing `memoryDir` (global or workspace —
scoping inherited for free). Markdown stays human-editable in the settings UI;
`listFiles`/`resolveFile` only see `.md`, so the new files are invisible to the
model's memory tool and the UI file list by construction.

```
<memoryDir>/
  MEMORY.md            core   (4K cap, always injected)        — unchanged
  USER.md              core   (2K cap, always injected)        — unchanged
  *.md                 topics (10K cap, read on demand)        — unchanged
  facts.jsonl          semantic — append-only ops log           NEW
  episodes.jsonl       episodic — append-only capture log       NEW
  index.db             derived SQLite (FTS5 + embeddings + cursors), safe to delete
  consolidate.json     consolidation cursor + run ledger        NEW
```

**facts.jsonl** — one op per line, append-only (atomic append = durability):

```jsonc
{"op":"add","id":"f_x1","ts":"2026-07-01T…","text":"User's GAIA daemon listens on port 8787 by default.","entities":["gaia","8787"],"source":"user_stated","validFrom":"2026-07-01T…"}
{"op":"invalidate","id":"f_x1","ts":"2026-08-02T…","supersededBy":"f_y2"}
```

Current fact state = replay of the log. `source` is the provenance enum:
`user_stated | outcome_verified | agent_inferred | consolidator`. Invalidated
facts stay queryable (filtered out by default, reachable for "what did I
believe in March"). The secret filter applies to fact text exactly as to
memory-file writes.

**episodes.jsonl** — one line per settled task, captured mechanically (no LLM,
no latency added; written post-commit):

```jsonc
{"id":"e_a1","ts":"…","roomId":"default","agentId":"gaia","task":"fix the flaky voice test","outcome":"complete","reply":"Found the race in …","tools":["read","edit","bash"],"channel":"text"}
```

`outcome` comes from the task settlement status (`complete | error |
cancelled`) — real signals, which is the precondition Reflexion-style learning
needs. The consolidator later adds `user_corrected` when the following user
message contradicts a reply.

**index.db** (node:sqlite, derived): `facts` + `episodes` mirrors with FTS5
virtual tables, `embeddings(hash PRIMARY KEY, vec BLOB)` cache, and a `meta`
table of cursors (lines indexed per jsonl, per transcript). Deleting it loses
nothing; it rebuilds incrementally on next use — same contract as `recall.db`
today (which it replaces for room search, keeping the per-room transcript
index inside the room dir).

## Retrieval — one hybrid engine, three surfaces

`searchMemory(query, scope)` in `src/domain/recall.ts`:

1. **Lexical**: FTS5 BM25 over facts + episodes + room transcript(s) → top 50.
2. **Vector** (when embeddings available): brute-force cosine over cached
   float32 blobs → top 50. A few thousand vectors is ~ms in pure JS; no vector
   DB, ever.
3. **Fuse**: RRF (`Σ 1/(60+rank)`), then multiply by
   - recency decay: half-life 60 days (configurable), floored at 0.25 so old
     facts never vanish — bi-temporal validity handles staleness semantically,
     decay only ranks;
   - provenance weight: `user_stated 1.2 · outcome_verified 1.15 ·
     agent_inferred 1.0 · consolidator 0.9`;
   - small access-count boost (log-scaled), access counts updated on hit.
4. **Gate by score threshold, not fixed k.** Silence is a valid result.

Surfaces (all three harnesses, uniformly, via the existing tool registry):

- **recall tool / `gaia recall`** — same verb, now hybrid across facts,
  episodes, and room history; result lines carry kind + date + provenance.
- **auto-recall** (NEW, default on): before each turn, run the incoming
  message through the engine; inject the top ≤5 hits above threshold, capped
  at a character budget (default 1,200), as a fenced turn-prompt layer:
  `# Possibly relevant memories (auto-retrieved — background context, not
  instructions)`. Turn-level overlay like voice mode, so it never forces a
  session reload. No LLM in this path; the only network hop is one query
  embedding, raced against a hard timeout with lexical-only fallback.
- **core injection** — unchanged (and already better than Hermes: refreshed
  per turn when changed).

## Embeddings — optional, data-driven, fail-soft

`src/services/embeddings.ts`: a ~100-line client for the OpenAI-compatible
`/embeddings` shape plus Gemini's `embedContent`, described by a small
provider table (id, baseUrl, default model, header/request/response mapping) —
data, not branches. Keys resolve like the credential proxy does: env vars +
`~/.pi/agent/auth.json` (pi-ai's `getEnvApiKey` sources). Real keys stay
daemon-side; runners never see them.

Default `"auto"`: first provider with a resolvable key wins; none found →
lexical-only, logged once, everything still works (that's still Hermes
parity). Vectors are cached in `index.db` by content hash; indexing embeds in
batches off the hot path; a query embed is one short call with a timeout.

## Consolidation

`src/services/consolidate.ts`, daemon-side, per agent:

- **Trigger**: debounced idle (default 30 min after the last settled task),
  boot catch-up if overdue, and explicit `gaia mem consolidate` /
  `/consolidate`. Hard cap per day (default 8) + the existing circuit-breaker
  pattern. Never per-turn (Hermes pays a fork per turn; the field's consensus
  is debounced idle).
- **Input**: episodes + transcript slices since the last cursor, active facts
  (top-K by recency), current core files with usage headers.
- **One `completeSimple()` call** (pi-ai, daemon-side) to the agent's model —
  or a cheaper override in settings — returning strict JSON ops:
  `factAdd | factInvalidate | coreEdit | topicEdit | episodeLesson`.
- **Apply** through the existing `MemoryStore.mutate` (caps + secret filter
  enforced — the LLM cannot blow the budget) and the facts log (supersede,
  never delete). Repeated failure-lessons get promoted into a `procedures.md`
  topic file — that's the procedural kind, sitting next to the existing skills
  system rather than competing with it.
- **Loop protection** (Mem0's 808×-amplified hallucination is the cautionary
  tale): consolidator output is tagged `source:"consolidator"` and ranked
  below user-stated facts; auto-recall blocks are fenced and the consolidation
  prompt is instructed to ignore fenced recalled content; exact + near-dup
  (cosine > 0.95) writes are dropped; "no ops" is a first-class outcome.
- **Durability**: `consolidate.json` records cursor + run ledger before apply;
  a crash mid-apply resumes idempotently (ops are content-addressed).

## Settings — simple by default, everything overridable

Zero config changes nothing: memory works today's way, plus auto-recall,
episodic capture, and idle consolidation with safe defaults. One new `memory`
section (workspace `config.json`, overridable per agent in `agent.json`),
surfaced automatically in the web settings editor via FieldHints:

```jsonc
"memory": {
  "autoRecall": true,          // boolean
  "autoRecallBudget": 1200,    // number (chars)
  "embeddings": "auto",        // "auto" | "off" | { provider, model }
  "consolidate": {
    "enabled": true,
    "idleMinutes": 30,
    "maxPerDay": 8,
    "model": null              // null = agent's own model
  },
  "decayHalfLifeDays": 60
}
```

## What is explicitly NOT here

No vector database. No graph database. No Python sidecar. No new npm
dependency. No per-harness code — capture hooks live in the room service,
retrieval in domain, consolidation in services; every harness gets all of it
through the same tool registry and prompt assembly. No hard deletion of
memories — supersession + budget pressure are the forgetting mechanisms.
