# connectome-host memory → gaia-daemon (recon, 2026-09-28)

src: connectome-host @e3573c9 · @animalabs/context-manager 0.11.0 (`strategies/autobiographical.ts` 11k LOC, `adaptive/*` kv-stable solver, `types/strategy.ts` defaults)
tgt: gaia-daemon @75a6a8eb · compaction = pi `session_before_compact` hook → `src/harness/pi/compaction.ts`

## standing bug (measured off source, not assumed)
- ordinary compact → `runCompactionFallback`: provider=anthropic ⇒ summarizer = **claude-sonnet-5, not the agent's model**
- pi `compact()` prompt: system="You are a context summarization assistant… conversation between a user and an AI assistant" + `## Goal/Progress/…` template → 3rd-person checklist, voice gone
- pi drops EVERYTHING before `firstKeptEntryId` → earliest events (origin/anchor) gone; summary rewritten wholesale each pass ⇒ cache prefix after system prompt changes every compaction

## gap table
| connectome feature | gaia-daemon equivalent | gap | port plan |
|---|---|---|---|
| summaryParticipant = agent.name; self-voice framing ("forming a memory… what you read is what happened") | none — neutral summarizer | voice lost | `compact.summaryVoice='agent'` → system = agent's OWN system prompt (`ctx.getSystemPrompt()`) + memory framing; first-person instruction |
| compressionModel = agent's own model family | sonnet-5 fallback for anthropic | wrong voice source | `compact.summaryModel='self'` → `ctx.model`; sonnet fallback only on self failure |
| in-band COMPRESSION_MARKER ("You will soon form a new memory, get ready") | none | jolt framing | port verbatim wording as the fixed lead of the user turn |
| prior recollections replayed AS OWN messages ("things I already remember") | `<previous-summary>` in user text | memory is external notes | prior memory = assistant-role message in compression request |
| headWindowTokens — origin pinned verbatim | none | origin erased | `compact.stablePrefixEvents` (default 4): first N messages serialized verbatim into a `<stable-prefix>` block at summary START; later passes carry it BYTE-IDENTICAL (never re-summarized) |
| KV-stable folding: fold only deep past, never rewrite live tail; compile plan keeps prefix | pi keepRecentTokens tail + whole-summary rewrite | prefix churn | summary layout = [stable-prefix][append-only recall index][coarse][recent memory]; older bytes only appended to, never rewritten ⇒ prefix system+head+index stable across passes |
| adaptive resolution L1→L2→L3 (mergeThreshold 6, targetChunkTokens 3000) | single flat summary | no gradient | `compact.adaptiveResolution` (default on): fold window split into `compact.resolutionWindows` (default 3) by age; newest → detailed memory (`compact.detailTargetTokens` 1500), middle → coarse (÷`compact.resolutionDecay` 4), oldest → ONE line each + `recall` query pointer (mechanical, no LLM) |
| chronicle keeps raw forever; retrieval module | room transcripts + `recall` verb | ✓ exists | oldest tier points at `recall` (query = salient terms of that window) instead of prose |
| thin-chunk guard (no LLM for <200 chars) | mechanicalCompactionFallback | partial | reuse: window below `compact.minWindowChars` (200) → stub line, no LLM |
| as-of vantage (no hindsight leak into memory) | n/a | minor | instruction: "write as you knew it then; no hindsight" |
| NO_TOOLS / plain-prose retry lines | n/a | robustness | strip `<thinking>` wrapper; empty output → mechanical fallback |
| kv-unified Pareto solver, receipts, cache-sim (≈7k LOC) | n/a | out of scope | NOT ported — needs chronicle message store + per-chunk frontier; pi session is linear. Layout rule above captures the cache property that matters |
| witnessed-record voice (inherited history pre-first-turn) | n/a | minor | deferred |
| image aging (maxLiveImages) | context-diet | covered elsewhere | none |

## vendor vs port → PORT
- license: context-manager/chronicle/agent-framework/membrane package.json = MIT (context-manager ships NO LICENSE file; agent-framework+membrane do)
- vendoring rejected: autobiographical.ts assumes Chronicle event store + Membrane NormalizedRequest + own message store; gaia's substrate = pi `SessionEntry[]` + `CompactionResult`. Adapter > port; ~19k LOC for ~4 ideas
- ported = ideas + marker/instruction wording (MIT, attributed in source)

## where it lands
- `src/core/compact-memory.ts` — knobs + defaults + parse (workspace `.gaia/config.json` `compact`)
- `src/harness/pi/autobio-compaction.ts` — pure layout (prefix/index/windows) + voiced request + LLM call
- `src/harness/pi/compaction.ts` — ordinary compact path routes through autobio when `summaryVoice='agent'`; neutral = old behaviour byte-for-byte
