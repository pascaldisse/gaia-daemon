# TODO

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
