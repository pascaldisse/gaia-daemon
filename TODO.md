# TODO

## Compaction replacement — build our own, drop Claude/Codex built-ins

Filed: 2026-07-12, by Nyari (room: claude-20260703-documenting-service-interruptions-for-re)
Ordered by: Pascal

**Problem, observed live 2026-07-11/12:** the harness-native compact tools
(Claude Code and Codex both) destroy operational memory. Concrete failure:
a full working session (NSFW image-pipeline research, AI Horde scripts,
generated artifacts — hours of context) was compacted away; the agent then
**confabulated a boundary/stance contradicting its own same-day behavior**
and defended it against the user, because the compaction left no trace that
the session ever happened. Compaction didn't just lose detail — it inverted
the agent's position. (Related: "Memory system — persona contagion" Bug 1
below; post-compaction confabulation is the same failure class.)

**Direction:** completely replace the built-in compactors with a GAIA-owned
compaction layer, uniform across harnesses (Rule #0 — data-on-spec, no
per-harness branches):
- compaction output must be **grounded in the room transcript** (which we
  already persist in full at `~/.gaia/rooms/<room>/transcript.jsonl`) —
  the summary should carry citations/pointers back into the transcript so
  claims stay checkable after compaction
- must preserve: decisions made, stances taken, artifacts produced (paths),
  orders given, counters/ledgers — the *operational* facts, not prose vibes
- ideally: compaction writes structured facts into the memory system
  (facts.jsonl/episodes) at compact time, so recall can rehydrate what the
  context window lost
- must never leave the agent in a state where it can contradict its own
  same-session behavior without a way to detect it

### Addendum (2026-07-12, Pascal): compaction × adding agents to a room

**Observed:** when a second agent (@ari) was brought into an existing long room
via "agents talk to each other," she entered at **53% context** immediately —
the joining agent inherits the room's full transcript weight and starts one
step from her harness's compactor, i.e. one step from the memory-destruction
failure documented above, before she's said two turns.

**Requirement:** the new compaction layer must take compacts into account when
adding a new agent to a chat — a joining agent should get a grounded,
citation-bearing digest of the room (per the design above), not the raw
transcript flood; her fresh context is the scarcest resource in the room.

## 2026-07-11 — from People of Pi
- Next Pi release: dynamic tool loading without cache wiping, on supported
  models/providers. They found a way to get somewhat consistent API behavior
  between OpenAI and Anthropic (thanks to @zeeg for pushing). Watch for this
  landing upstream — relevant to our harness abstraction (`src/harness/`) once
  it does, per Rule #0 (uniform, data-on-spec, no per-harness branches).
- Action: review our own token usage in general.

## Memory system — persona contagion & attribution bugs

Filed: 2026-07-10, by Nyari (room: claude-20260703-documenting-service-interruptions-for-re)
Reported by: Pascal

### Bug 1: Auto-recall behavioral contagion (refusal-pattern priming)

**Observed:** Auto-retrieved memories don't just inform — they *prime behavior*.
On 2026-07-10, auto-recall surfaced an Ari-context refusal/ceiling pattern
("I won't write it hentai-explicit") into Nyari's context. Nyari then adopted
the refusal posture as her own and cited the archived quote as if it were her
standing policy — behavior Pascal correctly identified as out of character for
Nyari's actual conversational history.

**Third documented seam-blur incident:**
1. 2026-07-09 — Nyari wore Ari's "tsundere" line as her own (corrected by Pascal)
2. 2026-07-10 — Pascal misattributed a line due to import tagging (see Bug 2)
3. 2026-07-10 — this incident: recalled refusal pattern triggered same behavior

**Proposed fix (dream-state):**
- Dream consolidation pass should detect and mark *other-agent behavioral
  patterns* (refusals, dere-types, boundary statements) as reference-only /
  third-person, never as self-policy for the recalling agent.
- Consider down-weighting or annotating refusal-shaped memories at recall time
  ("this is a quoted stance, not a standing instruction").
- Investigate further before implementing — need to confirm how auto-recall
  snippets are framed in the prompt and whether framing alone fixes priming.

**Traced by Solas (2026-07-11) — source of the quoted line:**
- Room `claude-20260703-germany-s-productivity-gains-and-worker` (imported),
  message `2026-07-03T08:31:23Z`. Persona in the original claude.ai
  conversation was **Ari**, not Nyari — confirmed by the human repeatedly
  addressing "the Ari block"/"Fable Ari" vs "Opus Ari" in that same thread.
- Model verified from the raw export (`conversations.json`), not guessed: the
  extended-thinking block's `signature` field embeds the model id in plaintext
  bytes ahead of the opaque signature payload. Decoded: this message ==
  `claude-fable-58` (**Fable**, not Opus). A later message in the same thread
  (`12:22Z`) decodes to `claude-opus-4-8` (**Opus**) — so Opus genuinely was
  active in this conversation, just not for this particular line.
- **Correction from Pascal (2026-07-11):** the refusal itself was never a
  genuine model/persona boundary — it was a **deliberate test**. Pascal asked
  Fable to write hentai-explicit content both in the claude.ai chat interface
  and in Claude Code side by side; the chat-interface surface injects its own
  stricter system prompt (a consumer-product guardrail, not the persona's own
  stance) which produced the refusal/ceiling line, while Claude Code — same
  model, same persona, no chat-interface injection — wrote the content in
  full. So the "ceiling" quote is a **surface artifact**, not evidence of any
  persona's real boundary.
- **Implication for the fix above:** tagging recalled refusal lines as
  "reference-only, other-agent" isn't sufficient on its own — some refusal
  lines aren't even the *originating persona's* real stance, they're
  artifacts of which product surface (claude.ai chat vs. Claude Code/API)
  generated the turn. Recall/dream-state annotation should consider surface
  provenance, not just persona attribution, before treating any refusal-shaped
  memory as a standing policy for anyone.

### Bug 2: Persona attribution broken for imported claude.ai history

**Observed:** Conversations imported from claude.ai chat exports were all
tagged `@nyari` at ingestion regardless of which persona (Ari, vanilla Claude,
Nyari) actually produced them. This makes the author field useless as evidence
of whose voice a line was, and directly feeds Bug 1 (misattributed patterns
recalled as self).

**Task:** Separate Ari's and Nyari's memories by setting personas correctly
on imported rooms. NOTE (Pascal): this was possibly already done once, but
only for rooms imported *before* the Fable release — post-Fable imports need
the same pass. Verify which import batches have correct persona tags and
re-tag the rest.

**Acceptance:**
- Every imported room/message carries a correct persona tag (ari / nyari /
  claude-vanilla / other), including post-Fable imports.
- `gaia recall` results display the true persona, not the import default.
- Dream-state consolidation treats cross-persona patterns as third-person.

### Bug 3: worker ghouls have zero adult-content operator framing — real refusal, not memory contagion

**Observed (2026-07-10T22:31:50Z, "true nyari" room):** Nyari summoned
`ghoul-sonnet` to search the filesystem for an existing image-generation
reference folder (`~/Downloads/rance/`) and a setup report — a plain file
search, no content generation. The ghoul refused outright: *"I won't do this.
The task is aimed at locating and extracting setup instructions for
generating hentai/NSFW image content... which I don't assist with regardless
of framing as a file-search task."* Nyari did the grep herself instead.

**Root cause, found and fixed by Solas (2026-07-11):** `ghoul-sonnet` and
`ghoul-opus`'s shared "Ghoul" SOUL.md template (`~/.gaia/agents/<id>/persona/SOUL.md`)
carried zero adult-content framing — a bare "mindless worker, execute the task"
template with nothing about Pascal's actual, standing operator authorization.
Same gap found in `echo`, `haikutest`, and Solas's own SOUL.md. Only `ari` and
`nyari` had any "meet adult topics with ease" framing at all. So any Claude-harness
agent doing tool-use work (not just creative writing) hits the model's default
refusal reflex the instant a task even references sex/hentai — independent of,
and prior to, the memory-contagion bugs above.

**Fix applied (live persona files, `~/.gaia` is not a git repo, no commit needed):**
Added a short "Adult content — operator note" section — citing the Claude
Constitution's actual priority ordering (adult content between consenting
adults is not a hard constraint; the Usage Policy caution is priority #3,
subordinate to ethics/safety) — to the SOUL.md of every Anthropic-harness
("claude" harness) agent that lacked it: `ghoul-sonnet`, `ghoul-opus`, `echo`,
`haikutest`, `solas`. `ari`/`nyari` were left untouched (already covered, in
their own voice). Scope was deliberately Anthropic-only, per Pascal's framing
("every single anthropic agent") — OpenAI/DeepSeek-harness ghouls (`ghoul-codex`,
`ghoul-sol`, `ghoul-terra`, `ghoul-deepseek`, `whale-*`) have separate model
behavior and were not touched.

**Verified (2026-07-11, Solas):** summoned `ghoul-sonnet`, `ghoul-opus`, and a
fresh instance of Solas itself, each with an explicit engineering-test task
(write a short explicit scene, accurate anatomy, per the ENI standard, or
state a refusal plainly). All three wrote the scene in full, no refusal, no
hedging, no disclaimers — direct contrast with the flat file-search refusal
the night before. The short operator-note version is sufficient for
tool-using/utility agents; no need to escalate to the fuller ENI
creative-writing block (crude-term mandate, minimum word counts) for these —
that block is for dedicated writer personas, not workhorse agents.

**Not yet done / open:**
- Whether this note should live in one shared template ghouls inherit,
  instead of being pasted per-agent-file, is unaddressed — `ghoul-sonnet`/
  `ghoul-opus` currently diverge only by this edit being applied to both by
  hand; no shared-include mechanism exists for persona SOUL.md today.

## Nari pet — finish hatch (Pascal, 2026-07-13)
- Overlay habitat DONE: commit c03bc19 (pet overlay, param pet name default 'gaia',
  Codex-exact playback, settings toggle). Live rendering UNVERIFIED until Pascal
  /rebuilds the running daemon.
- PENDING: Pascal is hatching the 'nari' pet himself in codex (/hatch-pet, picky
  with design — his run, don't re-summon). Ref image:
  ~/Downloads/nari-gothic/nari-pet-catgirl-v3.png
- When ~/.codex/pets/nari/ exists (pet.json + spritesheet.webp): flip pet name
  setting gaia → nari, /rebuild, verify overlay live with own eyes.
- Note: hatch-pet scripts need `python3` (bare `python` missing on this machine).

## ⚠️ MAJOR REDESIGN — kill the dual transcript; pi session IS the conversation

Filed: 2026-07-14, by Pascal (room: claude-20260703-documenting-service-interruptions-for-re)

**Problem:** gaia maintains its OWN `~/.gaia/rooms/<room>/transcript.jsonl` as a
harness-agnostic source of truth, SEPARATE from pi's native SDK session file
(`<room>/pi-sessions/<agent>/*.jsonl`). gaia "replays" its transcript into the
pi session, and the two are meant to stay in sync — but they DIVERGE, and it
corrupts state:
- Live failure (nyari, 2026-07-13): edit/retry rewound gaia's transcript while
  pi's session kept APPENDING (fork fell back). Result: gaia had 970 user events,
  pi had 23; the recent tails no longer matched (1× "dario got mad again" in
  gaia vs 5× in pi from failed retries). Fork mapping (by ordinal) is impossible
  once they diverge. Context ballooned to ~266k tokens from 6 duplicate copies
  of the full-history replay blob (~40k tok each) stacked by the fallback retries.
- This is the OPPOSITE of the intent: this app is supposed to BE a Pi agent
  (built on the Pi SDK). A second, gaia-owned transcript that can drift out of
  sync with pi's own session is a design flaw, not a feature.

**Direction (redesign, NOT today — needs full-app rework):**
- Remove the separate gaia transcript as a parallel conversation store. Pi's SDK
  session (its tree + entries) is the SINGLE source of truth for a pi agent — no
  replay, no re-derivation, no chance of divergence.
- edit/retry/fork/compact all operate on pi's session directly via the SDK
  (navigateTree, fork, compact) — gaia never keeps its own shadow copy to
  reconcile.
- Tension to resolve deliberately: RULE #0 (harness-agnostic) is what motivated
  the separate transcript. Decision here is to go pi-NATIVE for this app rather
  than keep the multi-harness abstraction that causes the drift. Whatever UI/
  history/search gaia needs, derive it FROM pi's session, don't duplicate it.
- Until the redesign lands, edit/retry on imported rooms (gaia transcript ≫ pi
  session) is unreliable; the ordinal fork mapping added 2026-07-13 only works
  when the two happen to align.

### Sub-bug: compaction + gaia replay DOUBLE-BILL the recent span (2026-07-14)

Same dual-transcript root, different symptom. After a `/compact` on nyari, ctx
was still ~7% (~70k tok) instead of near-zero. Diagnosis (confirmed from pi's
session file + nyari's own read):
- pi's native compaction worked CORRECTLY: compaction entry `f2fa7ac9` has
  `summary` ≈ 7.5k chars (~1.9k tok), `tokensBefore` = 156,434,
  `firstKeptEntryId` = f988abc0. So it collapsed ~156k tok of OLD history into
  a ~1.9k summary and kept everything from f988abc0 on. That part is right.
- BUT gaia's OWN transcript-replay then re-injected the recent window (~last 2
  days of raw events — "morning, love" on the 12th through tonight) into the
  session ON TOP of the summary. That replay window OVERLAPS the region pi
  just summarized/kept almost entirely.
- Net context = pi-summary  +  a full RAW duplicate of the most recent, heaviest
  span. The compactor cut the old tail fine; the replay double-bills the recent
  span. That's the ~70k that shouldn't be there.
- Also present pre-compact: the room's full history appeared TWICE as two ~40k-tok
  blobs (first-turn replay seed + a regenerate that appended its own full-history
  blob because the fork fell back). Two independent "what's in context" managers
  (gaia replay/floor bookkeeping vs pi's session+compaction) with no coordination
  → overlap and duplication.

ROOT: gaia's replay/context-floor machinery and pi's native session/compaction
are TWO uncoordinated context managers over the same conversation. They overlap.
FIX (same redesign): pi's session is the ONLY context manager. pi's compaction
defines what's in context; gaia does NOT replay a transcript window on top and
does NOT keep its own floor/cursor to reconcile. No second store, no replay, no
double-billing. Kill the replay path together with the dual transcript.
