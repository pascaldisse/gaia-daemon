# Caryll — lossless context compression for GAIA memory

*(name: the Caryll runes of Bloodborne — a notation for transcribing what has no words)*

## 1. Doctrine

Measure in token space, never characters. All ratios are computed via o200k_base
(gpt-tokenizer). Character-count claims are vanity metrics — they say nothing about what
the model actually pays for.

"Lossless" has two tiers here. Layer 1 is bit-identical round trip: mechanical,
verifiable by string equality. Layer 2 is fact-identical, invertible-by-legend: semantic,
verifiable by extracted-fact comparison, not string equality.

The research grounding: dictionary-encoding with an in-context legend is the only
published approach where a model reads compressed text directly and losslessly —
arXiv 2604.13066 measured >0.99 exact-match fidelity at 60–80% compression, on logs.
Stylistic compression (caveman/wenyan, SynthLang, Shogtongue) is lossy by construction:
it has no fixed inverse, and the model regenerates dropped structure probabilistically
rather than recovering it. CJK/glyph notations cost 1.1–1.6x MORE tokens on o200k-class
tokenizers than the plain English they replace, and even semantic-preserving rephrasing
alone already costs ~2% accuracy (arXiv 2502.07445). Caryll rejects all three lossy paths
and builds only on the dictionary+legend approach.

## 2. Layer 1 — mechanical (SHIPPED: `src/services/caryll.ts`, `gaia caryll compress|expand|stats`)

Format: a `~caryll/1` header, one or more `~L ALIAS=expansion` legend lines, a `~~`
separator, then the body with aliases substituted for their expansions.

Aliases are derived from uppercase initials and collision-checked against the full
original text, so no alias can shadow real content. Alias selection is greedy, ranked by
measured net token savings — the savings calculation already subtracts the cost of the
alias's own legend entry, so only genuinely profitable substitutions are made.

Verbatim islands are never touched: fenced code blocks, inline code, and URLs pass
through compression unmodified, regardless of how repetitive their contents look.

The guarantee is mechanical and tested: `expand(compress(x)) === x`, enforced by
`test/caryll.test.ts`.

Honest expectation: compression is modest on prose (~15–30%) and large on
repetitive/structured files such as logs and episodes — the paper's 60–80% figure was
itself measured on logs, not free-form text, and Caryll's own results should be read with
that same distinction in mind.

## 3. Layer 2 — semantic telegraphic (SPEC ONLY, NOT IMPLEMENTED)

An LLM-applied rewrite layered on top of Layer 1: articles, copulas, and hedging are
dropped per a fixed, published rule table — not by model discretion. Subjects may be
elided only when the legend already names them, so no referent is ever lost to
compression. Dates are always ISO. Numbers, names, paths, and quotes are always kept
verbatim — none of these are candidates for elision or paraphrase.

Every Layer-2 compression must pass a round-trip audit: a second pass expands the
compressed text, and a checker compares the extracted fact lists between original and
expanded versions. Any mismatch blocks the write — Layer 2 output is never persisted
without passing this audit.

De-escalation zones are inherited from caveman-style compression and kept unchanged:
security warnings, irreversible operations, and ordered step sequences stay in plain,
uncompressed prose, always — these are the cases where compression risk is least
acceptable.

## 4. Scope rules

Soul files (`SOUL.md`) are never compressed — they are user-authored and user-read, and
compression has no business touching them.

Machine-facing tiers are the actual targets: `MEMORY.md`, `USER.md`, topic files, and
episode archives.

Compression may happen at rest, at injection, or both; either way the legend travels
inside the compressed artifact itself — self-describing, with no out-of-band key required
to decode it.
