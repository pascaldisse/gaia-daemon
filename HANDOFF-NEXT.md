# Next steps — monad merged + credential-proxy done; nanoclaw §2/§3 remain

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

## Remaining

1. **nanoclaw §2 — host-sweep / orphan-reaping.** Tag spawned children with a
   per-install label; sweep this install's orphans on daemon start. See
   `HANDOFF-NANOCLAW.md` §2.
2. **nanoclaw §3 — circuit-breaker.** Wrap harness/summon launches in a breaker
   keyed by target; trip after N failures, fast-fail during cooldown, half-open
   probe. See `HANDOFF-NANOCLAW.md` §3.
3. **Credential-proxy follow-ups (optional):** a full-daemon e2e summon through the
   proxy against a fake provider (the mechanism is already proven by the egress
   integration test); then claude/codex redirect (`HANDOFF-NANOCLAW.md` §1 tail).
