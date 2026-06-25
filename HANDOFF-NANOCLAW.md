> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# Adopting nanoclaw patterns — implementation spec

Three patterns from nanoclaw to bring into gaia core, in build order:
**(1) credential-proxy → (2) host-sweep / orphan-reaping → (3) circuit-breaker.**

## Reference

nanoclaw (`qwibitai/nanoclaw`): a multi-agent daemon whose agents run
docker-sandboxed. Source: `tmp/nanoclaw/` (snapshot in this repo) and
`/Users/pascaldisse/Downloads/test/nanoclaw`. gaia's sandbox registry already
mirrors its one-file runtime swap. Key files: `src/container-runtime.ts`,
`src/container-runner.ts`, `src/providers/claude.ts`, `src/circuit-breaker.ts`,
`src/host-sweep.ts`, `src/session-manager.ts`.

## 1. Credential-proxy — in-daemon, UNIFORM across all harnesses (DONE)

**Premise (verified by source trace):** gaia does NOT inject provider keys — no
`*_API_KEY` is set anywhere; all spawn sites spread full `process.env`; each harness
uses its own auth (pi → `AuthStorage`/`~/.pi/agent/auth.json`, MULTI-PROVIDER;
claude/codex → their CLI's env key or OAuth). The exfil risk is a sandboxed summon
reading the cred store (the whole `auth.json`) or an env-exported key. Hiding the
turn's OWN key needs a proxy; OneCLI was rejected (a Docker stack + MITM CA, not "a
brew install"). So: a minimal in-daemon proxy on the existing harness bridge.

**Mechanism:** the daemon (unsandboxed) reads the real key; a proxied turn talks to a
loopback endpoint carrying only its per-turn token; the daemon injects the real key
and streams the response. The real `auth.json` is both deny-read in the sandbox and
side-stepped (Pi's agent dir relocated), and provider key env vars are stripped — so
the turn cannot reach the key by file, env, or its own auth store.

**Default OFF**, opt-in via `sandbox.credentialProxy` (workspace or agent); resolved
in `resolveSandboxPolicy` and applied **UNIFORMLY to every harness** in `RunnerHost` —
no per-harness branch (AGENTS.md §RULE #0). Each harness declares its egress wiring as
DATA on its spec (`HarnessSpec.credentialProxy`); the shared layer never asks which
harness it is.

Three surfaces, all wired and tested:
- **Transport** `src/app/llm-proxy.ts` — `forwardLlmRequest(req,res,upstream,subpath)`
  streams to the real upstream, injects the real key over the token, strips hop-by-hop
  headers, fail-closed 502 (never echoes the key). `joinUrl` + `llmProxySubpath` +
  `LLM_PROXY_MOUNT` own the path math.
- **Resolver** `src/app/upstream-resolver.ts` — daemon-side `resolveUpstreamCredential(agent)`:
  keyed by the model's PROVIDER (works for any harness), real `ModelRegistry.find().baseUrl`
  + `AuthStorage.getApiKey()`; auth-header shape by provider wire protocol (anthropic
  `x-api-key`, else bearer — provider data, not a harness case); undefined (refuse) for
  OAuth/subscription/unconfigured.
- **Endpoint** `handleLlmProxy` in `src/web/server.ts` — verifies the bearer
  (`harnessBridge.verify`), loads the agent, resolves the upstream (502 if none), forwards.

**Daemon→child plumb** (`RunnerHost`, uniform when `credentialProxy` on): set
`GAIA_LLM_PROXY_URL` (reusing `GAIA_DAEMON_TOKEN`), `stripProviderKeys` removes every LLM
provider key env var (`src/app/provider-key-env.ts`) FIRST, then apply the harness's
declared `credentialProxy({proxyUrl, token, scratchDir}) → {env, denyRead}` — a generic
per-room `scratchDir` + the harness's own env redirect + its cred store deny-read. Zero
harness-id branches.

**Per-harness wiring (declared on each spec, applied uniformly):**
- **pi** (`pi-runtime.ts`): relocate Pi's store via `PI_CODING_AGENT_DIR` → the scratch
  dir with an empty `auth.json`; deny-read the real `~/.pi/agent/auth.json`. Plus, in
  `applyCredentialProxy`, the in-process moves: **Auth** `registerProvider(provider,
  {apiKey:<token>, authHeader:true})` (NOTE: (a) `AuthStorage` WINS over a registered
  apiKey, so the empty store + stripped env are REQUIRED for the token to be sent; (b)
  `getApiKey` falls back to env regardless of `includeFallback`, hence the strip);
  **Egress** redirect the provider origin to the proxy at the fetch layer
  (`src/runtime/llm-proxy-fetch.ts`), leaving `model.baseUrl` REAL (pi-ai keys per-provider
  request compat off the baseUrl string — e.g. deepseek's reasoning role / `store` — and
  the dynamic `registerProvider` baseUrl-override ignores `compat`, so rewriting it would
  corrupt the request; pi uses `globalThis.fetch`, so the wrapper intercepts).
- **claude** (`claude-runtime.ts`): `ANTHROPIC_BASE_URL=<proxy>` + `ANTHROPIC_AUTH_TOKEN=<token>`.
- **codex** (`codex-runtime.ts`): `OPENAI_BASE_URL=<proxy>` + `OPENAI_API_KEY=<token>`.
- A future harness adds ONE `credentialProxy` field on its spec — the shared layer needs
  no change. OAuth/subscription modes resolve no key → the resolver fail-closes (correct,
  not a special case).

**Verified:** unit (transport, resolver, subpath, strip, redirect, policy) + an egress
integration test driving the REAL openai SDK through redirect→proxy→inject→fake upstream
(token in, real key out, stream back) + an on-machine seatbelt deny-read of an
out-of-cwd secret + `buildEnv` strip/gate/scratch + a live isolated daemon confirming the
endpoint is reachable and fail-closed on a bad token.

**claude/codex: DONE via the same uniform mechanism** (not "later", not separate) — their
`HarnessSpec.credentialProxy` declarations (above) route egress through the proxy; the
shared `RunnerHost` applies them identically to pi. End-to-end validation against the real
claude/codex CLIs is part of the live test pass; the mechanism is uniform and unit-tested.

## 2. Host-sweep / orphan-reaping (DONE)

**nanoclaw mechanism:** every child is labeled `nanoclaw-install=SHA256(cwd)`;
`host-sweep.ts` reaps only children carrying *this install's* label, so peer
checkouts never reap each other. Dual stuck-detection: an absolute heartbeat-age
ceiling, plus a per-claim stuck check; orphaned ack rows are deleted post-kill.

**gaia gap (closed):** was only manual `pi-agent prune`. A SIGKILLed daemon could
leave a wedged agent-runner behind (clean shutdown already self-exits children on
the stdin EOF, so this is the crash case only).

**What shipped** (`src/runtime/orphan-reaper.ts`, no docker / no two-DB — gaia is
process-based, not nanoclaw's container model):
- **Label:** every agent-runner carries a `--gaia-install <id>` argv marker, id =
  `sha1(GAIA_HOME)[:12]` (`installId` / `currentInstallId`, memoized). The runner
  ignores the flag — it's a pure, `ps`-visible label scoped to the checkout.
  Appended in `RunnerHost.spawnChild`.
- **Sweep:** `reapOrphans()` runs `ps axww -o pid=,ppid=,command=`, and
  `selectOrphans` (pure, unit-tested) picks rows that carry THIS install's marker
  AND whose parent is gone — ppid 1 or a ppid not present as a live pid in the
  table — excluding the daemon itself and its own children. Matching on the marker
  (not a recorded PID) makes PID reuse harmless. SIGTERM, best-effort: off
  darwin/linux, a `ps` failure, or a per-pid kill error all just log and continue.
- **Boot hook:** `GaiaWebServer.listen()` calls `reapOrphans()` first thing.
- **Covers summons** (a summon is a child room through the same RunnerHost, so its
  runner carries the marker too).
- **Verified:** unit tests (parse/select purity, self/sibling safety, best-effort
  guards) + an on-machine real-`ps` proof that a genuinely-orphaned (ppid 1) marked
  sleeper is found and signalled.
- **Known limit:** reaps the runner orphans, not their grandchildren (a runner's
  own tool subprocesses), which carry no marker. Acceptable — they're short-lived
  / die with the session; revisit with an inherited `GAIA_INSTALL_ID` env + `ps e`
  if grandchild leakage ever shows up. No periodic re-sweep (boot-only) — the crash
  window is restart-bounded; add a timer if long-uptime leakage appears.

## 3. Circuit-breaker (DONE)

**nanoclaw mechanism (`circuit-breaker.ts`):** a file-backed state machine —
attempt counter + timestamp, backoff schedule `[0,0,10,30,120,300,900]s`, 1-hour
reset window; runs before DB init; SIGTERM deletes the state file.

**gaia gap (closed):** was no resilience layer — a flaky harness/provider was
re-launched on every turn with no backoff or trip.

**What shipped** (`src/runtime/circuit-breaker.ts`). NB nanoclaw's breaker guards
daemon STARTUP across process restarts (hence file-backed); gaia's guards LAUNCHES
within a running daemon, so it's **in-memory** — a restart resets every breaker,
which is what you want (restarting *is* "try again").
- **`CircuitBreaker`** keyed by target string, injectable clock. `closed` →
  (N consecutive failures) → `open` (fast-fail with `retryInMs` for the backoff
  `cooldownScheduleMs`) → after cooldown `half-open` (one probe) → `onSuccess`
  closes + clears, a failed probe reopens with the next, longer cooldown. Idle past
  `resetMs` (1h) → fresh. `canAttempt` / `onSuccess` / `onFailure` / `snapshot`.
- **Shared** daemon-wide via `defaultBreaker` (a down provider fast-fails for every
  room, not just the one that tripped it), overridable per-host for tests.
- **Wired into `RunnerHost`** at the spawn→`ready` handshake (key
  `harness:provider/model`): `ensureChild` fast-fails when the breaker is open;
  `ready` = success; a `resolveSandboxLaunch` throw (fail-closed sandbox) / child
  `error` / exit-before-`ready` (crash-on-start) = failure, settled exactly once
  per attempt via a `launchSettled` guard. **Covers summons** (same RunnerHost).
- **Scope:** launch health only, NOT mid-turn provider hiccups — a turn that fails
  after a clean `ready` doesn't trip the breaker (avoids false trips on transient
  in-turn errors).
- **Verified:** `test/circuit-breaker.test.ts` (trip / cooldown / half-open / reopen
  / reset / per-key isolation) + a crash-on-start integration test in
  `test/runner-host.test.ts` (first turn trips, second fast-fails with "circuit open").

## Out of scope (core)

- **Channel bridges** (Telegram/Discord/etc.) — supported as **plugins**, not in
  core. gaia core stays the multi-human + multi-AI group-chat room engine.
- **Approval / command-gate (human-in-the-loop)** — the sandbox + trust tier is the
  isolation boundary for summons; summons run autonomously. Tighter
  sandbox/permissions or a better-scoped summon is the lever, not an approval gate.
- **Flat agent-to-agent mailboxes** — covered by the monad engine
  (summons-as-subrooms + routing policy + `access_list` data-flow); see
  `HANDOFF-MONAD-ENGINE.md` on branch `worktree-research+openfugu-setups`.

Smaller deltas, not blocking: no retry/backoff on transient harness failures; no
daemon-side runner/summon liveness (only the pi-agent watchdog + LRU eviction);
confirm Seatbelt writable paths are canonicalized against symlink escape.

## Pointers

- gaia: `npm run build`, `npm test`. Confinement entrypoint
  `src/runtime/sandbox/exec-cli.ts`; trust tier `src/app/summon-policy.ts`; Seatbelt
  profile `src/runtime/sandbox/macos-seatbelt.ts`.
- pi: `~/projects/pi-agent/pi-agent.mjs`; `~/.claude/skills/pi/bin/pi-selftest`
  (11 assertions; `PI_GAIA_CLI` overrides the gaia cli path).
