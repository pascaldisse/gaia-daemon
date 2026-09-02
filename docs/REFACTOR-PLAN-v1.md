# REFACTOR-PLAN v1 — 2026-09-02 (nyari · room chat-mtk78q14-wa40)

Inputs → docs/REFACTOR-INVENTORY.md (5d2487f) · docs/PLUGIN-RECON.md (e4deb5e) ·
docs/EDIT-RESEND-LIVETEST.md (pending lane). Laws → AGENTS.md (§RULE0 · layering ·
merge-only root · testing). Every atom = own ghoul lane · own commit · gate before merge.

## §0 Ground truth (blocking)
- main HEAD red: host.ts:407 `compact-clean` ∉ committed RunnerCommand union (71e80b5 half-landed).
- root dirty: env.ts·memory.ts·events.ts·host.ts·pi.ts(+) uncommitted in merge-only root.
- A0 → owner of root WIP identified → committed on a branch → `bun run check` green on main. NOTHING below merges before A0.

## §1 Principles
- Pi-only is a FACT, not a license: abstraction stays (spec.ts registry · RunnerHost · protocol.ts). Delete dead *implementations*, never the seam.
- Refactor = move + split + delete. No behaviour change inside a refactor atom; behaviour atoms separate.
- Each atom ≤ ~450 lines touched · one bounded system · exemplar named in spec (sonnet-equal territory).
- Untested-large file → test lands IN the same atom that splits it (19 files, inventory §7).

## §2 Waves (parallel inside a wave · serial across)

### W1 — hygiene (all independent, one wave)
- A1 layering: `harness/tools-pi.ts` → 4 upward imports (services artifacts·caryll·web-search·web-fetch)
  → invert: services inject tool impls via spec data / a `ToolProviders` port in harness/protocol; harness imports nothing above.
- A2 dead code: knip 109 unused files + 59 types → delete in 3 sub-atoms (core+domain · services · web/src+scripts+setups). Claude export script · Claude TTS engine · stale CLI examples in `harness/proc.ts` · legacy harness aliases (core/harness-id.ts keep normalizer, drop alias table if unreferenced).
- A3 duplication: inventory §6 helpers (json response · ~/.gaia path resolve · transcript read · sleep/retry) → one module each in core/, callers rewired.
- A4 knip config committed (`knip.json`) + `bun run check` runs it → dead code can't regrow.

### W2 — god-file splits (one lane per file; no cross-file coupling)
- A5 `server/http.ts` (2084 · handleApi 944) → route table: `server/routes/<domain>.ts` (rooms · agents · memory · artifacts · usage · edit/retry) + `server/route.ts` (match+json helpers). http.ts = listener + dispatch only. Test: `test/http-routes.test.ts` per domain.
- A6 `services/room-service.ts` (4441 · runAgentTask 490 · sendMessage 190) →
  - `services/room/turn-loop.ts` (runAgentTask · queue drain · pendingTurn commit)
  - `services/room/fork.ts` (forkAtUserMessage · resetAfterTruncation · rewind · sanitize glue)
  - `services/room/context-gate.ts` (floor · compaction summary replay · gate)
  - room-service.ts = façade ≤ 800. Exemplar for splits: services/summons/*.
- A7 `daemon.ts` (1567 · reloadNow 218 · configureRoomServiceReload 125) → `daemon/reload.ts` · `daemon/wiring.ts`; daemon.ts = boot sequence.
- A8 `harness/pi.ts` (1262) → `pi/session.ts` (ensureSession · fork) · `pi/tools.ts` · `pi/events.ts`; registration file stays data-only.
- A9 `core/types.ts` (1380) → per-domain type files under core/types/; barrel re-export keeps imports stable.

### W3 — plugin system (needs W1 A1 port + W2 A6 façade)
Source → PLUGIN-RECON §steal-list. Land in `services/plugins/` (v2 organ-donor: types·manifest·loader adaptable ~1:1).
- A10 manifest: `plugin.json` {id · version · engine · placement: daemon|runner · requiredCaps[] · contributes: {commands · tools · channels · providers}} · validate-ALL → import · duplicate id / path escape rejected before code runs.
- A11 registry: staged generations + atomic swap · disposer per plugin · failed reload ⇒ old generation survives · swap only at RoomService turn-finally (turn lease).
- A12 capability broker: `services/capabilities` resolves requiredCaps per operation w/ {roomId, agentId}; plugins never self-police. Trust tier data-driven (trust:false ⇒ sandbox, never config-weakenable).
- A13 typed contribution ports: command · tool · channel-bridge · provider → explicit contracts in services/plugins/contracts.ts; runner-side wire → harness/protocol.ts. Harness adapters remain data.
- A14 migrate existing `~/.gaia/plugins/*.mjs` duck-typed loader → manifest path; legacy .mjs w/o manifest ⇒ warn + synthesized manifest for one release, then drop.
- Non-goals: Cordis/fibers · YAML `!!js` config · HMR (compiled bun binary; only Pascal reloads).

### W4 — edit/resend (fill after EDIT-RESEND-LIVETEST verdict)
- Known: ordinal fork (gaia Kth user msg ↔ pi Kth user entry) = same assumption broken 08-19 (31 vs 13).
- If BROKEN → A15: one-room-one-tree — gaia event id recorded on pi entry (fork by id, never ordinal); steer/agent→agent turns tagged so they never count as user entries; fallback WAL-replay stays.
- If WORKS-clean-only → A15 same, priority lower; A16 live regression test in test/ (ephemeral daemon pattern 1fea449).

## §3 Order & gates
A0 → W1 (parallel) → W2 (parallel) → W3 (A10‖A12 → A11 → A13 → A14) → W4.
Every atom: `bun run check` + `bun test test/<touched>.test.ts` in lane worktree → merge main into branch → ff-only to root. Live-path atoms (A6 fork · W3 · W4) additionally: real `gaia summon` luna through ephemeral daemon, output pasted.

## §4 Routing
terra default · sonnet backup · W2 splits = pre-chewed (exemplar + conventions) → sonnet-eligible · W3 A11/A12 design-heavy → terra/sol.
