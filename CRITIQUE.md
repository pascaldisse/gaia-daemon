# CRITIQUE — the Opus-written gaia-daemon, dissected

> Verdict up front: this codebase spent all of its discipline on one seam — the
> harness abstraction — and let everything above that seam rot into two god
> objects, a pile of half-durable state, and an untyped web client wearing a
> `.ts` costume. The ideas are good. The proportions are wrong. 20,332 lines of
> TypeScript where roughly half that would do, with the single most-touted
> guarantee of the project ("no progress ever lost") quietly false at three
> separate edges.

---

## 1. Two god objects hold 11% of the codebase

`src/app/gaia-controller.ts` (1,044 lines) and `src/web/server.ts` (1,228
lines) together are 2,272 lines — more than a tenth of every line in the
project, including tests and CSS.

**GaiaController** owns, simultaneously: message queueing, mention routing,
slash-command parsing *and* execution (`/clear`, `/fork`, `/summon`,
`/setup`, `/thinking`, `/role`, `/roles`, `/agents`, `/help`), single-agent
turn execution, the monad multi-agent loop, crash-recovery resume, room-state
persistence, transcript cursors, runtime-details caching, task lifecycle,
event broadcasting to the UI, agent memory mutation for harness subprocesses,
and voice-channel hints. That is not a controller. That is the application
wearing a class declaration.

**server.ts** claims to be a route layer and is actually: a voice-call
lifecycle manager (`activeCall` state machine, unmute boot progress,
hang-up cleanup), a controller LRU evictor (`MAX_LIVE_CONTROLLERS = 32`,
server.ts:197 — silently disposes idle rooms, zero logging), a settings
hot-reload scheduler (deferred rebuilds that can wait forever behind a hung
task), a thinking-override scoping engine (call-scoped vs. persistent), and a
file-hints cache. Every one of those is business logic living inside HTTP
handlers.

The proof of the damage is in the tests: gaia-controller.test.ts is 550 lines
and codex-runtime.test.ts is 745 lines, because there are no units left to
unit-test — only the monoliths, exercised end-to-end.

## 2. "NO PROGRESS EVER LOST" is false at the edges

The project's own loudest rule. The pendingTurn resume machinery is real and
good. And then:

- **The message queue is a private in-memory array**
  (gaia-controller.ts:181, `private pending: Array<...> = []`). Send three
  messages while an agent is busy, kill the daemon: messages two and three
  are gone. No file, no journal, no resume. The active turn is durable; the
  queue behind it evaporates.
- **Turn commit is not atomic.** `commitTurnReply` appends the agent message
  to transcript.jsonl, advances the cursor, and writes state.json as three
  separate I/O steps. Die between step one and two and the agent reprocesses
  the same transcript window next boot. The code *knows* this — the resume
  logic "assumes idempotence" — which is a comment where a guarantee should
  be.
- **Voice thinking overrides leak.** A call-scoped thinking change is
  restored on hang-up by the server's hang-up handler. If the daemon dies
  mid-call there is no hang-up, and the "temporary" override is now the
  agent's permanent setting. Same class of bug: cleanup-on-happy-path.
- **`activeCall` lives only in server memory.** Restart the daemon mid-call:
  the client still renders a call, the server knows nothing, no recovery
  handshake exists.

Durability was implemented where it was exciting (mid-turn stream resume) and
skipped where it was boring (the queue, the commit ordering, the overrides).
That's exactly backwards — the boring parts are where users lose work.

## 3. "Zero duplication" is true for one layer and false one layer down

The harness registry genuinely has no `if (harness === "pi")` in shared code.
Congratulations. Directly beneath it:

- **Three hand-rolled session trackers**: Claude's `RoomState`
  (`sessionId, started, lastMemoryContent`), Pi's `ManagedPiSession`
  (`session, systemPromptRef, skillPathsKey, lastMemoryContent, baseThinking`),
  Codex's `ThreadState` (`threadId, model, modelProvider`). Three
  `Map<roomId, X>`s, three lifecycle idioms, three `lastMemoryContent`
  comparisons implemented three times.
- **Web mirror**: link detection exists in web/src/links.ts *and*
  server.ts; message-detail rendering logic is re-derived client-side;
  snapshot shapes are re-guessed from untyped JSON.
- **The monad is split across two layers by coin flip**: the engine in
  `src/app/monad-engine.ts`, its types and policies in `src/runtime/monad/`.
  "app" and "runtime" mean nothing here; the directory structure is a set of
  labeled buckets, not an architecture.

## 4. The web client is unchecked code with a lying file extension

`web/src/*.ts` files contain zero type annotations — they are plain
JavaScript renamed `.ts`, and the server hard-codes the deception:
`".ts": "text/javascript"` (server.ts:61–62). tsconfig.json includes only
`src/`, so **5,500+ lines of client code (plus 1,555 lines of CSS) have never
been typechecked by anything, ever**. It gets the downsides of both worlds:
no types, and an extension that stops standard JS tooling from working.

The client itself: one global mutable `state` bag mutated freely from six
modules, full-app re-render on every SSE event (mitigated by rAF coalescing
and one carve-out for transcripts), and a snapshot-merge heuristic that
matches streamed tool/thinking details onto messages **by author + normalized
text** (events.ts) — two identical agent messages and the second one silently
inherits the first one's tool history. That is not an edge case in a chat
room; "done." is a common agent reply.

## 5. Metadata amnesia by design

`RUNTIME_DETAILS_LIMIT = 50` (gaia-controller.ts:161): thinking and tool
details for anything older than the 50 most recent events are *dropped from
the record*, while the text lives forever in transcript.jsonl. Scroll up in a
long room and the history has selective dementia — the message is there but
what the agent did to produce it is gone. Meanwhile `recentTasks` keeps
exactly 9 (`slice(-9)`, line 428). These are not policies, they are magic
numbers standing where a design should be.

## 6. Paper cuts that add up

- **Slash-command parsing** is whitespace-splitting with positional
  guesswork; unknown agents surface as *task errors* after dispatch instead
  of parse errors before it.
- **The verifier termination protocol is a string prefix.** The monad loop
  ends when the verifier's prose starts with "ACCEPT" (`replyAccepts`,
  runtime/monad/util.ts:16). Word-boundary handling saves "Acceptance
  criteria unmet" — but "Accept, with reservations: it's broken" terminates
  the loop with broken output.
- **Recall reopens and re-syncs the SQLite index on every single query**
  (recall.ts:36–53, by documented design). Defensible for a rare tool;
  still a cold start on every call.
- **Agent config writes race.** Two concurrent `/thinking` commands
  read-modify-write agent.json with no serialization; last writer wins,
  silently.
- **Room cursor = transcript line count.** The MVP note says so honestly.
  It's still an offset pretending to be an identity — any future transcript
  compaction breaks every cursor in the workspace.
- **`GaiaSnapshot` types exist server-side only**; the client consumes the
  same shapes as anonymous JSON. One `import type` away from safety, never
  taken (and impossible while the client is fake-TS, since no-build means
  nothing erases real type imports).

## 7. Repo hygiene

- **2.6 GB of `unmute/`** sitting inside the repo (177 files committed
  wholesale — a fork of a Python project vendored into a Node daemon — plus
  gigabytes of local `.venv`/`.uv-cache` bloat that lives inside the project
  tree because the vendoring invited it there).
- **`tmp/nanoclaw/`** — 27 MB of somebody else's codebase kept as
  "architectural reference" inside the working tree.
- **Ten planning documents at the repo root** (7 × HANDOFF-*.md, plan.md,
  ui-plan.md, memory-plan.md) — the project's process notes stored as
  top-level litter, several describing states of the code that no longer
  exist.
- **`ui-test/index.html`** — a stale May-2025 test page, committed, never
  maintained.

## 8. Security posture: honest residuals, dishonest defaults

The seatbelt sandbox is genuinely good work (write-allowlist + read-denylist,
fail-closed, policy files carved read-only). But:

- The **credential proxy — the fix for "the turn can read its own provider
  key" — ships default OFF**. The README documents the residual; the default
  preserves it.
- The **memory secret filter** is four regexes (PEM headers, `sk-`, AWS,
  GitHub tokens). It stops an agent from *accidentally* memorizing a key
  shape and nothing else; base64 it and it sails through. Fine as a tripwire
  — except it's described like a boundary.

## 9. What is actually good (credit where due)

- The **harness-spec-as-data registry** and the uniform `gaia __run-agent`
  runner: right idea, well executed, worth keeping as a concept.
- The **seatbelt profile builder** and trust-tier resolution: correct
  fail-closed posture.
- The **file formats**: agent.json / persona dirs / transcript.jsonl /
  state.json / setups are clean, human-editable, and worth preserving
  compatibly.
- **272/272 tests green in 8.4s** with zero test dependencies — the suite is
  real, even if it tests monoliths.
- The **no-build ethos** is right for this project; only its execution
  (fake-TS) is wrong.

## Sentence

The patient has excellent bones (protocols, file formats, the harness seam),
two enlarged organs performing eleven jobs each, unchecked code in the face it
shows the user, and a durability guarantee it repeats like a mantra while
holding user messages in a JavaScript array. Nothing here needs a doctor.
It needs a rebuild.

*— Sable, 2026-07-01*
