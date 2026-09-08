# Reasoning + auto-compaction · 2026-09-08

§Source → room branch `astra/chat-mtsgpu37-69lr`; integrated code `d0f5042`; main NOT landed; compiled daemon NOT reloaded.
§Commits → reasoning `b4f003d`/`240b5c6`/`d0f5042`; UI `dde92bb`/`ca3093c`; scheduler `92d9d4f`/`9332594`; integration `b3654c1`.

§Parent gates → `bun run check` exit0; knip advisory output retained.
§Isolated files → `bun test test/<name>.test.ts`, one process/file; `TMPDIR=$PWD/.gaia/integration-proof/test-tmp`.
- auto-compact19/0; workspace-auto-compact1/0; commands8/0; workspace8/0; rooms53/0.
- model-reasoning5/0; hints4/0; runner-host20/0; pi-runtime65/0.
- `bun test web/src/reasoning.test.js` →19/0.
- Focused subtotal202PASS/0FAIL at integration `b3654c1`.
- Final `d0f5042`: checkPASS; room-service112PASS/1FAIL; sole failure `a stalled turn with no partial reply requeues ONCE...`→5000ms timeout. Worker independently reproduced untouched root `9d6563d`; timeout NOT relaxed.
- Prior integration room-isolation failure→configured default off vs undefined; exact fixture metadata+no shared-agent mutation/crossroom leak assertions preserved in `d0f5042`.
§Raw local evidence → `.gaia/integration-proof/{check-final,room-service-final,auto-compact,workspace-auto-compact,commands,workspace,rooms,model-reasoning,hints,runner-host,pi-runtime,web-reasoning}.log`.

§Live baseline only → parent real Luna summon `luna-mtsi4bv8fkt5pz` returned `AUTO_COMPACT_BASELINE_OK`; backend reports `REASONING_BACKEND_LIVE_BASELINE_OK`. Neither exercises changed compiled source.
§UI → worker reproduced old universal menu; parent passive console→TAURI missing-callback warning. New UI LIVE UNVERIFIED; no live call-toggle/menu/editor acceptance claimed.
§UI correction → call request supersedes room descriptor; effective absent/unverified, never fabricated; unknown toggle inert; always-on model menu only, no implicit off/cycle. Absent-descriptor legacy fallback retained; genuine unknown descriptor no invented choices.
§Editor → generic config JSON surface + wildcard field hints; live editor acceptance OPEN.
§Compaction → default180000 used tokens; exact-model patch→room precedence; whole-turn boundary, NOT mid-turn hard cap; native capacity/reserves unchanged. Schema→AUTO-COMPACT.md.
§Deployment gate → main integration + Pascal reload + real changed-path summon/auto-compaction + owned-app UI acceptance pending; live app/global config untouched.
