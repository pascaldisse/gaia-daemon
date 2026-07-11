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
