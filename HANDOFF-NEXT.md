# Next steps — merge monad, then finish the credential-proxy

Sequenced entry point for the next session. Two handoffs hold the detail:
`HANDOFF-MONAD-ENGINE.md` (on the monad branch) and `HANDOFF-NANOCLAW.md` §1 (here).

## Status snapshot

- **main @ `79f5a1c`** — credential-proxy CORE built + tested (additive, nothing
  routes through it yet): `src/app/llm-proxy.ts` (stream-forward + inject real key,
  fail-closed) + `src/app/pi-credential-resolver.ts` (host-side real upstream+key) +
  `test/llm-proxy.test.ts`. Sandbox = Seatbelt-only. **233/233 green.**
- **branch `worktree-research+openfugu-setups` @ `0d69d92`** — monad engine +
  RoutingPolicy registry + setup system + Fugu plugin (P1+P2+P3). Clean tree,
  **233 green** on its side. Done, merge-ready.

## Step 1 — merge monad into main

Branch is 2 ahead / 3 behind main (forked at `5445675`, before the seatbelt-dedup
and the proxy core). **The conflict surface is ONE file: `src/cli.ts`.** Both sides
add a subcommand dispatch in `main()` — main added the `__sandbox-exec` branch
(reads `rawArgs`, must run BEFORE the `--dev` filter), the monad branch added
`gaia setup` / `gaia serve`. Resolution = keep both: `__sandbox-exec` first, then
the rest. Everything else is disjoint:
- monad adds: `src/runtime/monad/*`, `src/app/monad-engine.ts`, `src/setups/*`,
  `setups/*`, `plugins/fugu/*`, and edits `src/app/commands.ts`,
  `src/app/gaia-controller.ts`, `src/room/state.ts` (none touched on main since fork).
- main adds/edits: `src/runtime/sandbox/*`, `src/app/llm-proxy.ts`,
  `src/app/pi-credential-resolver.ts`, `src/runtime/bridge-deps.ts`, docs.
- `src/runtime/sandbox/apple-container.ts` stays deleted (branch never touched it).

```
git checkout main
git merge worktree-research+openfugu-setups
# resolve src/cli.ts: union of both command dispatchers (__sandbox-exec stays first)
npm run build && npm test        # expect green; merged test count = union of both sides
git commit
```

Post-merge check: the monad engine dispatches via `SummonHost.summonAndWait` — main
did not change that signature in the dedup, so it should line up; re-run `npm test`
and a quick `gaia setup activate monad` smoke to confirm. Detail + file map:
`HANDOFF-MONAD-ENGINE.md` §0 on the branch.

## Step 2 — finish the credential-proxy

Resume at **`HANDOFF-NANOCLAW.md` §1 "REMAINING wiring"** (the core is already on
main). Order: endpoint (`/api/harness/llm/*` in `src/web/server.ts`) → env plumb
(`RunnerHost.buildEnv` + `RUNNER_ENV`) → pi `registerProvider` redirect
(`src/runtime/pi-runtime.ts`) → sandbox `auth.json` deny-read + `PI_CODING_AGENT_DIR`
→ config gate (default OFF) → **isolated live verify** (separate `GAIA_HOME` + temp
workspace + non-8787 port; never touch the real `:8787` daemon or `~/.gaia`). All
APIs are verified in §1.

## Then — the rest of the nanoclaw adopt-list

`HANDOFF-NANOCLAW.md` §2 (host-sweep / orphan-reaping) and §3 (circuit-breaker).
