# Adopting nanoclaw patterns — implementation spec

Three patterns from nanoclaw to bring into gaia core, in build order:
**(1) credential-proxy → (2) host-sweep / orphan-reaping → (3) circuit-breaker.**

## Reference

nanoclaw (`qwibitai/nanoclaw`): a multi-agent daemon whose agents run
docker-sandboxed. Source: `tmp/nanoclaw/` (snapshot in this repo) and
`/Users/USER/Downloads/test/nanoclaw`. gaia's sandbox registry already
mirrors its one-file runtime swap. Key files: `src/container-runtime.ts`,
`src/container-runner.ts`, `src/providers/claude.ts`, `src/circuit-breaker.ts`,
`src/host-sweep.ts`, `src/session-manager.ts`.

## 1. Credential-proxy — in-daemon (decided with user), pi-harness first

**Corrected premise (verified by source trace):** gaia does NOT inject provider
keys — no `*_API_KEY` is set anywhere; all spawn sites spread full `process.env`;
each harness uses its own auth (pi → `AuthStorage`/`~/.pi/agent/auth.json`, which is
MULTI-PROVIDER; claude/codex → their CLI's env key or OAuth). So the real exfil
risk is a sandboxed summon reading the cred store (esp. the whole `auth.json`) or an
env-exported key. Hiding the turn's OWN key needs a proxy; OneCLI was rejected (it's
a Docker stack + MITM CA, not "a brew install" — see §Out of scope rationale in
memory). We build a minimal in-daemon proxy on the existing harness bridge instead.

**Mechanism:** the daemon (unsandboxed) reads the real key; a redirected harness
talks to a loopback endpoint carrying only its per-turn token; the daemon injects
the real key and streams the response. Real `auth.json` is deny-read in the sandbox.

**DONE (built + tested, 233/233 green, additive — nothing routes through it yet):**
- `src/app/llm-proxy.ts` — transport core: `forwardLlmRequest(req, res, upstream, subpath)`
  streams to the real upstream, injects `upstream.authHeaders` (real key) over the
  placeholder, strips hop-by-hop headers, fail-closed 502 (never echoes the key).
  Plus `joinUrl`. SDK-free, unit-tested with a fake upstream.
- `src/app/pi-credential-resolver.ts` — `resolvePiUpstream(agent, deps?)`: daemon-side
  `AuthStorage.create()` + `ModelRegistry.create()` → `find(provider,name).baseUrl`
  + `getApiKey(provider)` → `UpstreamCredential`; returns undefined (refuse) for
  OAuth-only/unconfigured. Injectable deps for tests.
- `test/llm-proxy.test.ts` — 6 tests (key-injection, streaming, fail-closed, resolver).

**REMAINING wiring (verified APIs; do in isolation, never touch the real :8787 / ~/.gaia):**
1. **Endpoint** in `src/web/server.ts`: add `url.pathname.startsWith("/api/harness/llm/")`
   to `handleApi`; verify the bearer via `harnessBridge.verify` (mirror `handleHarness`,
   ~line 568); load the agent for `claims.agentId`; `const up = await resolvePiUpstream(agent)`;
   if `!up` → 502; else `await forwardLlmRequest(request, response, up, subpathAfterMount)`.
2. **Expose the proxy URL** on `HarnessHost` (`src/app/harness-bridge.ts`): add e.g.
   `llmProxyUrl = ${baseUrl}/api/harness/llm`; reuse the existing per-turn token.
3. **Env plumb** `RunnerHost.buildEnv` (`src/runtime/runner-host.ts:190`): when the
   proxy is enabled, set `GAIA_LLM_PROXY_URL` (+ reuse `GAIA_DAEMON_TOKEN`); add the
   const to `RUNNER_ENV` (`src/runtime/runner-protocol.ts`).
4. **Pi redirect** in `src/runtime/pi-runtime.ts`: when `GAIA_LLM_PROXY_URL` is set,
   `modelRegistry.registerProvider(agent.model.provider, { baseUrl: <proxy>/v1, apiKey: <token>, authHeader: true })`
   before `resolveModel()` (confirmed: placeholder apiKey wins over auth.json).
5. **Cred-store isolation:** set `PI_CODING_AGENT_DIR` to a per-turn scratch dir with a
   minimal/empty `auth.json`, and add the real `~/.pi/agent/auth.json` to the sandbox
   **read-denylist** for proxied turns (`src/runtime/sandbox/macos-seatbelt.ts` +
   `exec-cli.ts --deny-read`). Verify pi doesn't deadlock on the denied read.
6. **Config gate** (default OFF): a `sandbox.credentialProxy` flag (or trust-tier
   coupling) so existing turns are unchanged until opted in.
7. **Isolated live verify:** separate `GAIA_HOME` + temp workspace + non-8787 port;
   run a real pi summon through the proxy; confirm the reply works AND `auth.json` is
   unreadable inside the turn AND the real key never appears in the child env.

**claude/codex (later):** claude api-key mode → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN=<token>`
(anthropic uses `x-api-key`/`authorization`); codex → custom `base_url` + `OPENAI_API_KEY=<token>`.
OAuth/subscription modes have no key to proxy — leave them as-is.

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
