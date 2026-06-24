# Unification Refactor — Plan

## STATUS (2026-06-24, branch feat/claude-harness)

Done + committed, each its own commit, 197/197 green + tsc clean throughout:
- **Phase 0** `6816aaf` — one harness descriptor (runtime/harness-registry.ts +
  runtime/index.ts barrel; self-registration; AgentHarness=string; one
  parseHarness; HARNESS_CONFIGS deleted).
- **Phase 1** `04fa634` — permissionMode visibility is a `supportsPermissionMode`
  capability; the last `!== "claude"` logic leak is gone.
- **Phase 2** `ed0afbc` — one gaia-tool registry (tools/gaia-tools.ts); pi/claude/
  prompt/CLI/settings all iterate it; fixed the settings `summon` drift; registry
  stays import-light via lazy makePiTool.
- **Phase 5** `239dc4e` — deleted dead SummonCoordinator.cancel + redundant
  GaiaController.summonAndWait hop; deduped the timeout string. (Kept the running
  map + latestReplyFrom: correct, not duplication.)
- **Phase 6** `2ee37c7` — one config/defaults.ts (DEFAULTS) + GAIA_HOST/GAIA_PORT.
  (Left single-site constants/secret-patterns/personas as-is: one source already.)

Result: **no harness-id branching remains in daemon logic.** Harnesses, tools,
capabilities, and defaults are each a single registry/source. Adding a harness =
one runtime file + one barrel line; adding a tool = one registry entry.

Remaining = Phases 3, 4, 7 — NOT independent. They are one atomic change:
Phase 4 (Pi runs as a per-room subprocess runner like the others) is what *forces*
Pi's memory/recall/summon onto the HTTP bridge (Phase 3) and is the single process
the sandbox wraps (Phase 7). The Codex `memory`-only limit is a symptom: its token
is minted roomless at app-server spawn (codex-runtime.ts:486) because the
app-server is shared; a per-room runner gives it a per-room token and recall/summon
become uniform. There is no safe partial slice — it must land atomically (the
plan's own rule), touching every turn of every agent + all the runtime test
injection points. Do it as a focused effort; spec below is unchanged.

---

Goal: make the daemon *one uniform thing*. A harness, a tool, a sandbox backend
is added by dropping in **one module** and it just works. No harness-id literals
outside a single descriptor. No concept implemented twice. Nothing hardcoded that
should be config. The sandbox (the original ask) falls out for free once execution
is uniform.

Reference for the target shape: `tmp/nanoclaw` — one-file runtime swap
(`container-runtime.ts`), self-registering provider/channel registries + barrels,
per-entity JSON config, and "every provider runs the same way" (`createProvider`
→ one poll loop; only the SDK translation differs).

## Principles (the test every change must pass)

1. **One descriptor per kind.** Add a harness/tool/sandbox = one file + one barrel
   import line. Nothing else edited.
2. **Declared, never branched.** Differences between harnesses are *data on the
   descriptor*, read generically. Zero `=== "claude"` / `switch(harness)` outside
   the descriptor. Essential difference → capability field; accidental difference
   → fix it so the field is uniform.
3. **One path per concept.** A summon turn == a normal turn. An in-process tool ==
   a subprocess tool. One result-collection, one liveness source, one event map.
4. **Nothing hardcoded.** Defaults, limits, ports, secret patterns, seed personas
   live in config/templates, merged through the existing `mergeConfig`.
5. **Sandbox is harness-agnostic.** It wraps the *process that runs a turn*, which
   is the same process for every harness. It never reads the harness.

---

## Phase 0 — One harness descriptor (registry + barrel)

**Problem (audit):** a harness lives in 4+ places — `runtime-factory.ts:29` switch,
`HARNESS_CAPABILITIES` (`capabilities.ts:28`), `HARNESS_CONFIGS`
(`settings-hints.ts:63`), the `"pi"|"codex"|"claude"` union in 6 type sites, and
two byte-identical parsers (`workspace-loader.ts:36` `parseHarness`,
`scaffold.ts:50` `normalizeHarness`).

**Change:**
- `src/runtime/harness-registry.ts`: `registerHarness(id, spec)` →
  `Map<string, HarnessSpec>`. `HarnessSpec = { create(base): AgentRuntime,
  capabilities, ui }`. `harnessSpecFor(id)`, `harnessIds()`.
- Each runtime self-registers at the bottom of its own file; `runtime/index.ts`
  is a barrel of `import "./pi.js"` lines.
- `AgentHarness = string`. Delete the literal union from `agents/types.ts:36`,
  `workspace/types.ts:8`. Collapse both parsers to one
  `parseHarness(raw) = harnessIds().includes(raw) ? raw : undefined`.
- `runtime-factory.ts` → `harnessSpecFor(harness).create(base)`.
- `settings-hints.ts` reads `ui`/`capabilities` off the registry; `HARNESS_CONFIGS`
  deleted.

**Payoff:** add a harness = new `runtime/<x>.ts` + one barrel line. Capabilities and
UI metadata are co-located with the factory.

## Phase 1 — Capabilities declared, never branched

**Problem:** `settings-hints.ts:95` `if (harnessId !== "claude")` hides
`permissionMode` by literal id — the one true leak.

**Change:** add the missing capability fields to the descriptor (e.g.
`configFields` / `supportsPermissionMode`); settings-hints derives field visibility
from capabilities for *all* fields (it already claims to). Grep for every remaining
harness-id literal and route it through a capability.

**Payoff:** the settings UI is fully capability-driven; no harness strings in logic.

## Phase 2 — One gaia-tool registry

**Problem:** `memory/recall/summon` are re-encoded ~5×: Pi `defineTool`s
(`pi-runtime.ts:267`), Claude `GAIA_GRANTS` (`claude-runtime.ts:189`), the CLI
pointer text (`prompt-assembly.ts:115`), the CLI dispatch switch
(`cli-harness.ts:153`), the server endpoints (`server.ts:586`), and the
settings list (`settings-hints.ts:135`) — which has **already drifted** (missing
`summon`).

**Change:** `src/tools/registry.ts`: `registerGaiaTool(id, { make(ctx), cliVerb,
grantPattern, help, capability })` + `tools/index.ts` barrel. Pi wiring, Claude
grants, CLI pointer, CLI dispatch, server endpoints, and the settings list all
*iterate the registry*.

**Payoff:** add a daemon tool (e.g. `web`, `notify`) = one entry; it appears
in-process, over the CLI bridge, in the system prompt, and in the UI at once.

## Phase 3 — One IO surface for tools (and the Codex capability fix)

**Problem:** Pi calls `MemoryStore`/`summonCreate` directly in-process; Codex/Claude
go over the HTTP bridge (`harness-bridge.ts` + `/api/harness/*`). Two paths for one
concept. Codex's token is room-less (`codex-runtime.ts:476`), so
`capabilities.ts:31` strips recall/summon from Codex.

**Change:** route *all* tool calls through one daemon-side handler — Pi's in-proc
tool calls the same function the HTTP endpoint calls. Make the bridge token
room-resolvable at request time so Codex carries the active room.

**Payoff:** the `gaiaTools` divergence collapses — all harnesses advertise the same
tools (the accidental gap becomes uniform). One tool-call entry point.

## Phase 4 — KEYSTONE: one execution path (uniform runner)

**Problem (the split you flagged):** Pi runs in-process in the daemon; Claude spawns
per-turn; Codex runs one shared app-server. Three process models → the asymmetry
leaks into capabilities, summon wiring, and the bridge. This is *the* non-uniformity.

**Change:** one `gaia-agent-runner` entry that runs **any** harness via the
unchanged `createAgentRuntime(harness).send()` and streams `AgentEvent`s back over
**one** channel. The daemon launches it the same way for every harness; one
per-room runner. Shared turn machinery (`BaseRuntime`: per-room state map,
`modelLabel`/`liveModelLabel`, memory-change tracking, `resetRoom`) and shared
subprocess plumbing (`subprocess-host.ts`: spawn lifecycle, line framing,
PATH/shim, token mint) are hoisted once; each `runtime/<x>.ts` keeps **only** its
SDK/CLI translation. One event-type→`AgentEvent` map shared by controller +
turn-runner (today duplicated).

**On "don't rewrite pi":** `pi-runtime.ts`'s translation logic is **untouched** — it
just runs inside the uniform runner like every other harness instead of being
privileged in-process. That is the resolution of "every agent is exactly the same."

**Tradeoff to confirm:** this changes Pi's in-process session to a per-room runner
process (startup/perf characteristics shift; the daemon gains one event channel
from the runner). This is the one decision I want your explicit nod on before
building it — everything below depends on it.

## Phase 5 — Collapse the summon coordinator onto the uniform path

**Problem (refactor cruft):** `SummonCoordinator.cancel()` has zero callers;
`GaiaController.summonAndWait` is a near-dead pass-through the Pi path already
bypasses; a hand-maintained `running` map duplicates `controller.isBusy`; the
result is scraped post-hoc from the transcript (`latestReplyFrom` + a bespoke
5-min timeout + `"(no output)"`) instead of the in-band `turn.reply`.

**Change:** delete `cancel()` and `GaiaController.summonAndWait`; derive
`runningChildren` from busy child controllers (drop the map); collect the result
in-band by subscribing to the child turn (the voice path is the precedent),
deleting `latestReplyFrom` and the timeout protocol; collapse the `SummonCreate`
interface into the coordinator signature.

**Payoff:** a summon is *literally* a normal turn in a child room — no parallel
result/liveness/cancel machinery.

## Phase 6 — Nothing hardcoded (config + defaults + templates)

**Problem:** `MAX_LIVE_CONTROLLERS=32`, `SUMMON_TIMEOUT_MS=300_000` (+ a matching
`"5 minutes"` string), port `8787`/host (no `GAIA_PORT`/`GAIA_HOST`, never passed
from `cli.ts`), memory `FILE_LIMITS`/`SECRET_PATTERNS`, recall default `8` are
baked in. Defaults (`?? "pi"`, `model:{deepseek}`, `defaultAgent:"gaia"`,
`DEFAULT_ROOM`) live in code in 3 spots and can drift. Seed personas
(gaia/sidia/terry, prose SOULs) are hardcoded TS in `scaffold.ts`.

**Change:** one `defaults` block (harness/model/room/agent) consumed everywhere via
`mergeConfig`; `GAIA_PORT`/`GAIA_HOST` env like `GAIA_HOME`; operational limits into
config; `SECRET_PATTERNS` from a config file; seed personas become template files
copied by `ensureGlobalDefaultAgents`.

**Payoff:** behavior is data; a new install customizes without editing the binary.

## Phase 7 — The sandbox (the original goal — now trivial)

Because Phase 4 made *one process* run every turn, the sandbox just wraps that
process launch, identically for all harnesses.

**Change:**
- `src/runtime/sandbox/registry.ts` — `registerSandbox(id, backend)`, the
  NanoClaw `container-runtime.ts` one-file-swap analogue. `backend = { available(),
  wrap(argv, { cwd, writable[], net, env }) }`. Implementations: `apple-container`
  (now, reuses the pi-skill image approach), `docker` (later), `none`. Barrel +
  registry, swap = config.
- Policy `sandbox?: { enabled, backend?, writable?, net? }` on `WorkspaceConfig`
  (default) and `AgentDefinition` (override), resolved in the controller — **above
  the harness**. **Summons default `enabled: true`.** Fail-closed when the backend
  is unavailable.
- The runner spawn (Phase 4) goes through `sandbox.wrap(...)` when enabled, raw
  otherwise. The sandbox layer reads **nothing** about the harness.

**Payoff:** optional, swappable, default-for-summons, applies to all three
harnesses with zero harness branching — because they're all the same process now.

---

## Sequencing & risk

- **0–2, 5, 6** are low-risk dedup/registry/config work, each independently
  committable with `npm test` green. Do these first; they shrink the surface.
- **3, 4, 7** are the deep changes and are ordered: tool-IO symmetry (3) →
  uniform runner (4, the keystone) → sandbox (7). 7 is small once 4 lands.
- Every phase ends green (197 tests today) and is one commit. No phase leaves two
  paths half-migrated.

## Open decision (need your nod)

Phase 4: converging Pi onto the uniform per-room runner (its translation code
unchanged, but no longer privileged-in-process). This is what makes "every agent
exactly the same" true in the code and what the sandbox needs. Confirm and I start
at Phase 0.
