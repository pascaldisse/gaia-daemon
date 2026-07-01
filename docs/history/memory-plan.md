> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# Memory System Plan

Design from the June 2026 memory research pass (deep-research workflow: 23
sources, 21 claims surviving 3-vote adversarial verification). **Tiers 1-3
are implemented**; the "Later" section and the provider seam below are the
open items.

## Research conclusions

- Production systems converged on capped plain-markdown + agent-curated
  writes: Hermes agent (MEMORY.md 2,200 chars + USER.md 1,375 chars,
  add/replace/remove tool, error-on-overflow, consolidate-above-80% nudge),
  Anthropic memory tool (client-side /memories files, just-in-time agentic
  reads), Claude Code auto-memory (MEMORY.md index loaded at startup + topic
  files read on demand). GAIA's existing design is the same family.
- Vector/graph frameworks are scale optimizations, not quality wins at
  persona scale: mem0's own paper shows accuracy below full-context (the win
  is latency/cost); Zep/Graphiti gains appear at ~115k-token conversations
  and it regressed 17.7% on single-session questions. All benchmark numbers
  are vendor-run and mutually disputed (mem0 vs Zep LoCoMo feud).
- Feb 2026 survey (arXiv 2602.06052): no memory substrate dominates;
  text-record memory (core summary + edited lists) is a legitimate substrate.
- Hermes ships local-first recall as SQLite FTS5 lexical search — no
  embeddings. Verified: node:sqlite on Node v24.11.1 has FTS5 built in
  (zero dependencies, experimental-warning only).
- Nobody has solved multi-agent memory; every verified system assumes one
  agent / one user. GAIA's room model is uncharted territory.

## Proposed design (three tiers, all files + one SQLite index)

### Tier 1 — Core (always in context, per agent)

`persona/MEMORY.md` becomes a `persona/memory/` directory:

- `memory/MEMORY.md` — index + durable agent notes, cap ~4k chars
- `memory/USER.md` — what the agent knows about the user, cap ~2k chars

Both injected changed-only in the turn prompt (existing
`lastMemoryContent` mechanism in pi-runtime.ts, unchanged). Add
consolidation pressure: above 80% usage the tool result says so and tells
the agent to consolidate before adding (MemoryState.usage already exists).

### Tier 2 — Topic files (on demand, per agent)

`persona/memory/<topic>.md` for detail that doesn't earn always-in-context
status; MEMORY.md carries one-line pointers (Claude Code pattern). Memory
tool grows `read` + `list` actions and a `file` parameter (default
MEMORY.md). MemoryStore becomes directory-aware with per-file caps.
Settings UI already groups `memory`-category files — works for free.

### Tier 3 — Recall (episodic, per room)

FTS5 index over the room `transcript.jsonl` (node:sqlite, built lazily,
updated on append) + a `recall` tool: query → matching room events with
timestamps/speakers. Sub-ms locally, fits voice latency budgets, spans
sessions and cursor windows. The transcript stays the source of truth; the
index is disposable.

### Write policy

- Replace `UNSAFE_PATTERNS` in memory-store.ts — currently rejects any
  content containing "print"/"token"/"key" (fatal for a coding product).
  Keep only narrow real-secret detection (PEM headers, sk-/AKIA-style key
  shapes); drop the prompt-injection regexes (memory is the agent's own
  writing; the transcript is the injection surface).
- Keep error-on-overflow (already implemented), add the 80% nudge.

### Multi-agent (novel, GAIA-specific)

- Memory stays per-persona (the product's soul).
- Agents may keep notes about each other as ordinary topic files
  (`memory/agents/<id>.md`).
- Optional shared `.gaia/memory/ROOM.md` per project, writable by all
  agents — just another file in the existing tiers.

### Explicitly not building

Vector DB, embeddings, knowledge graph, background consolidation jobs,
decay scoring. Evidence says they don't pay at this scale. A Hermes-style
provider seam stays possible later; not pre-built (see below).

## Extension seam for a future provider (mem0-style)

All memory flows through `src/memory/` and exactly four call sites. A
heavier backend (mem0, Zep, embeddings) plugs in additively — the file core
keeps operating, Hermes-style — by hooking:

1. **inject** — `PiRuntime.send` builds the turn block via
   `MemoryStore.promptBlock(agent.memoryDir)`; a provider appends its own
   retrieved-context section here (prefetch before the turn).
2. **mirror** — the `memory` tool's `store.mutate(...)` call; a provider
   mirrors successful writes into its own store (`onWrite`).
3. **tools** — `PiRuntime.createManagedSession` assembles `customTools`
   from the agent's tool list; a provider registers extra tools there.
4. **recall** — `searchTranscript` in `src/memory/recall.ts`; a provider
   can substitute or augment lexical FTS5 with semantic retrieval.

Per the project rule (no abstraction until a second implementation exists),
these stay direct calls today; introduce a `MemoryProvider` interface only
when the first real provider lands.

## Status

1. ~~Directory split + read/list/file tool actions + consolidation nudge +
   UNSAFE_PATTERNS fix + legacy migration~~ — shipped.
2. ~~FTS5 recall: `src/memory/recall.ts` + `recall` tool~~ — shipped
   (node:sqlite, per-room `recall.db`, lazy incremental sync).
3. Later, if wanted: USER.md write-approval staging, shared room memory
   (`.gaia/memory/ROOM.md` writable by all agents), periodic
   self-consolidation nudges on a timer (Hermes-style) rather than only at
   write time.

Found while shipping: Pi's `createAgentSession` treats `tools` as an
allowlist over built-in AND custom tools, so filtering custom tool names
out of the list (the old GAIA wiring) silently disabled them — the memory
tool had never actually been visible to agents. Fixed by passing the full
`agent.tools` list as the allowlist; verified live (memory list/add +
recall calls executed by a real agent turn). Also note: a session whose
history contains the agent claiming a tool is missing can keep
confabulating that even after the tool appears; recreating the room
session clears it.

## Ideas stolen per system

- Hermes: small caps, consolidation pressure, USER.md split, provider seam
  concept, FTS5-not-embeddings recall.
- Claude Code: index + topic-file hierarchy, on-demand reads.
- Anthropic memory tool: file-directory tool surface (read/list actions).
- Zep/Graphiti: invalidate-don't-delete timestamping — noted, not adopted;
  the § ISO timestamps on entries already cover provenance at this scale.
