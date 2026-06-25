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

## 1. Credential-proxy — in-daemon, pi-harness (DONE)

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
in `resolveSandboxPolicy` and gated to the pi harness in `RunnerHost`.

Three surfaces, all wired and tested:
- **Transport** `src/app/llm-proxy.ts` — `forwardLlmRequest(req,res,upstream,subpath)`
  streams to the real upstream, injects the real key over the token, strips hop-by-hop
  headers, fail-closed 502 (never echoes the key). `joinUrl` + `llmProxySubpath` +
  `LLM_PROXY_MOUNT` own the path math.
- **Resolver** `src/app/pi-credential-resolver.ts` — daemon-side `resolvePiUpstream(agent)`:
  real `ModelRegistry.find().baseUrl` + `AuthStorage.getApiKey()`; undefined (refuse)
  for OAuth-only/unconfigured.
- **Endpoint** `handleLlmProxy` in `src/web/server.ts` — verifies the bearer
  (`harnessBridge.verify`), loads the agent, resolves the upstream (502 if none), forwards.

**Daemon→child plumb** (`RunnerHost`, gated to pi + `credentialProxy`): set
`GAIA_LLM_PROXY_URL` (reusing `GAIA_DAEMON_TOKEN`); relocate Pi's store via
`PI_CODING_AGENT_DIR` → a per-room scratch dir with an empty `auth.json`; deny-read the
real `~/.pi/agent/auth.json`; `stripProviderKeys` removes every LLM provider key env
var (`src/app/provider-key-env.ts`).

**Pi redirect** (`pi-runtime.ts` `applyCredentialProxy`, two deliberately-split moves):
- **Auth** `registerProvider(provider, { apiKey: <token>, authHeader: true })` — token
  as the key. NOTE the corrections that drove this shape: (a) `AuthStorage` WINS over a
  registered apiKey, so the empty `PI_CODING_AGENT_DIR` + stripped env are REQUIRED for
  the token to be what's sent, not optional hardening; (b) `getApiKey` falls back to env
  vars regardless of `includeFallback`, hence the env strip.
- **Egress** redirect the provider origin to the proxy mount at the fetch layer
  (`src/runtime/llm-proxy-fetch.ts`), leaving `model.baseUrl` REAL. This is deliberate:
  pi-ai keys per-provider request compatibility off the baseUrl string (e.g. deepseek's
  reasoning role / `store` param), and the dynamic `registerProvider` baseUrl-override
  path ignores `compat`, so rewriting the baseUrl would silently corrupt the request.
  Pi uses `globalThis.fetch` (openai SDK `getDefaultFetch`), so the wrapper intercepts.

**Verified:** unit (transport, resolver, subpath, strip, redirect, policy) + an egress
integration test driving the REAL openai SDK through redirect→proxy→inject→fake upstream
(token in, real key out, stream back) + an on-machine seatbelt deny-read of an
out-of-cwd secret + `buildEnv` strip/gate/scratch + a live isolated daemon confirming the
endpoint is reachable and fail-closed on a bad token.

**claude/codex (later):** claude api-key mode → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN=<token>`;
codex → custom `base_url` + `OPENAI_API_KEY=<token>`. OAuth/subscription modes have no
key to proxy — leave them as-is. The fetch-layer redirect pattern generalizes if a
harness keys behavior off the base URL.

## 2. Host-sweep / orphan-reaping

**nanoclaw mechanism:** every child is labeled `nanoclaw-install=SHA256(cwd)`;
`host-sweep.ts` reaps only children carrying *this install's* label, so peer
checkouts never reap each other. Dual stuck-detection: an absolute heartbeat-age
ceiling, plus a per-claim stuck check; orphaned ack rows are deleted post-kill.

**gaia gap:** only manual `pi-agent prune`. A daemon crash orphans pi managers and
summon subprocesses; nothing reaps them on restart.

**Design:** tag spawned children with a per-install label, add a sweep on daemon
start (and periodically) that reaps only this install's orphans whose parent is
gone. Reuse the runner lifecycle in `src/runtime/` + the controller's process
tracking.

## 3. Circuit-breaker

**nanoclaw mechanism (`circuit-breaker.ts`):** a file-backed state machine —
attempt counter + timestamp, backoff schedule `[0,0,10,30,120,300,900]s`, 1-hour
reset window; runs before DB init; SIGTERM deletes the state file.

**gaia gap:** no resilience layer — a flaky harness/provider is re-launched on every
turn with no backoff or trip.

**Design:** wrap harness/summon launches in a breaker keyed by target
(harness/provider/agent); trip after N consecutive failures, fast-fail during the
cooldown, half-open probe, reset after a clean window.

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
