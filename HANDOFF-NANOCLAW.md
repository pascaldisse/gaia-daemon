# HANDOFF — Adopt nanoclaw patterns (next phase)

Status: 2026-06-25. The sandbox consolidation is DONE and merged to `main`
(`663ec34`): macOS Seatbelt only (write-allowlist + read-denylist), one
`gaia __sandbox-exec` entrypoint the pi skill also confines through,
apple-container dropped + uninstalled. See `HANDOFF-SANDBOX.md` for that work and
the deferred credential-proxy. We are staying on `main` from now on.

## nanoclaw — the reference

Local copies: `/Users/USER/Downloads/test/nanoclaw` (the repo, has `.git`)
and `tmp/nanoclaw` (snapshot in this repo). nanoclaw (github `qwibitai/nanoclaw`)
is a mature multi-agent **messaging** daemon: agents run docker-sandboxed (Apple
Container is an opt-in via `/convert-to-apple-container`), reached over chat
channels, with approvals, agent-to-agent messaging, sqlite state, and circuit
breakers. gaia already borrowed its **registry one-file-swap** pattern
(`src/runtime/sandbox/registry.ts`). This phase = evaluate/adopt more of its
proven patterns. LESSON from the last round: read the actual nanoclaw source
before designing, don't guess.

Key nanoclaw files to read first:
- `src/container-runtime.ts` / `src/container-runner.ts` — runtime swap + run-arg
  build (docker is the default; the apple-container variant lives on branch
  `skill/apple-container`).
- `.claude/skills/convert-to-apple-container/SKILL.md` +
  `docs/APPLE-CONTAINER-NETWORKING.md` — the host NAT / IPv4-first /
  **credential-proxy** details (why our VM internet silently depended on host
  config; why apple-container was never self-contained).
- `src/circuit-breaker.ts`, `src/modules/approvals/`, `src/command-gate.ts`,
  `src/modules/agent-to-agent/`, `src/host-sweep.ts`, `src/session-manager.ts`.

## Concrete next task (DEFERRED from the sandbox work): credential-proxy

Today the provider key sits in the agent's env, so Seatbelt can't hide it (and pi
injects `DEEPSEEK_API_KEY` into the child env). nanoclaw runs a host-side
**credential proxy**: the proxy holds the real key, the agent talks to it over
loopback, and the raw key never enters the sandbox. Adopt:
1. Small loopback proxy that forwards to the provider, injecting the real key
   host-side; mint a per-turn token. gaia already has the HTTP bridge
   (`src/app/harness-bridge.ts`, `src/runtime/bridge-deps.ts`) as a model + likely
   host process.
2. Point the harness base URL at the proxy; strip the real key from the child env
   (pi: drop the DEEPSEEK env injection in `deepseekOnlyEnv()`; gaia: stop
   forwarding provider keys).
3. Scope the token to the turn; bind to loopback.
Closes the last exfil gap (the turn's own key) — the residual called out in
`src/runtime/sandbox/macos-seatbelt.ts` and the README.

## Candidate nanoclaw patterns to evaluate — CONFIRM SCOPE WITH USER

Priority is not yet specified; ask which the user wants. Menu:
- **Credential-proxy** (above) — the definite one.
- **Circuit breaker** (`circuit-breaker.ts`) — trip flaky agents/providers instead
  of hammering them; gaia has no resilience layer today.
- **Approvals / command-gate** — human-in-the-loop gating for sensitive actions;
  complements gaia's trust tiers (which gate *sandboxing*, not *approval*).
- **Orphan reaping by install-label / host-sweep** — crash-safe cleanup. Still
  relevant post-container: a daemon crash can orphan Seatbelt pi jobs; nanoclaw
  scopes cleanup by a per-install label so peer installs don't reap each other.
- **Agent-to-agent messaging** (`modules/agent-to-agent`) — compare to gaia's
  summons-as-subrooms; nanoclaw routes a2a destinations explicitly.
- **Probably out of scope:** channels (WhatsApp/etc) — gaia is a room daemon, not
  a messaging-platform bridge.

## Pointers / how to run

- gaia (on `main`): `npm run build`, `npm test` (227 green). Confinement
  entrypoint `gaia __sandbox-exec` → `src/runtime/sandbox/exec-cli.ts`. Trust tier
  → `src/app/summon-policy.ts`. Seatbelt profile → `src/runtime/sandbox/macos-seatbelt.ts`.
- pi: `~/projects/pi-agent/pi-agent.mjs` (rewired) + `~/.claude/skills/pi`
  (`bin/pi-selftest` = 11 assertions against the real gaia path; `PI_GAIA_CLI`
  overrides the gaia cli path).
- apple-container work preserved, NOT merged: branch `feat/apple-container-backend`.

## First step for the next session

Ask the user which nanoclaw patterns to prioritize (likely the credential-proxy
first). Then read the relevant nanoclaw `src/` before designing, so we adopt the
real pattern rather than a guess.
