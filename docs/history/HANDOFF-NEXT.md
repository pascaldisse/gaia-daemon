> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# Next steps — monad + credential-proxy + nanoclaw §2/§3 all done

## Done

- **Monad merged into main** — the monad engine + RoutingPolicy registry + setup
  system + Fugu plugin are on main (one-file `src/cli.ts` union; `__sandbox-exec`
  stays first, then `setup`/`serve`). Smoke-checked: `gaia setup list` and
  `gaia __sandbox-exec` both work in isolation.
- **Credential-proxy (pi harness) — complete.** Full mechanism + verification in
  `HANDOFF-NANOCLAW.md` §1. Default OFF (`sandbox.credentialProxy`). Files:
  `src/app/llm-proxy.ts`, `src/app/pi-credential-resolver.ts`, `src/app/provider-key-env.ts`,
  `src/runtime/llm-proxy-fetch.ts`, plus wiring in `server.ts`, `harness-bridge.ts`,
  `runner-host.ts`, `runner-protocol.ts`, `pi-runtime.ts`, `sandbox/registry.ts`.
  Tests: `test/llm-proxy.test.ts`, `test/llm-proxy-integration.test.ts`,
  `test/runner-host-proxy.test.ts`, `test/sandbox.test.ts`.
- **nanoclaw §2 — orphan-reaping — complete.** `src/runtime/orphan-reaper.ts`:
  every agent-runner carries a `--gaia-install <id>` argv marker (id = sha1 of
  GAIA_HOME); `GaiaWebServer.listen()` `ps`-sweeps on boot and SIGTERMs marked
  processes whose parent is dead (ppid 1 or no live ppid) — peer checkouts and a
  live sibling daemon's children are untouched. Matching on the per-install marker
  (not a bare PID) means PID reuse can't mis-kill. Verified by unit tests +
  on-machine real-`ps` proof against a genuinely-orphaned marked sleeper.
- **nanoclaw §3 — circuit-breaker — complete.** `src/runtime/circuit-breaker.ts`:
  per-target (`harness:provider/model`) in-memory breaker shared daemon-wide
  (`defaultBreaker`), wired into `RunnerHost`'s spawn→`ready` handshake. Trips
  after N consecutive launch failures, fast-fails during a backoff cooldown,
  half-opens for one probe, closes on a clean launch. Covers summons too (they
  spawn through the same RunnerHost). Tests: `test/circuit-breaker.test.ts` +
  a crash-on-start integration test in `test/runner-host.test.ts`.

## Remaining (optional)

- **Credential-proxy follow-ups:** a full-daemon e2e summon through the proxy
  against a fake provider (the mechanism is already proven by the egress
  integration test); then claude/codex redirect (`HANDOFF-NANOCLAW.md` §1 tail).
