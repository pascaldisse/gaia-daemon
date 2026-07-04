# HANDOFF — thanks-dario mode (context sanitize)

Status as of 2026-07-04 ~00:45 CEST. Feature is CODE-COMPLETE and deployed;
one live incident is open (§3). 303/303 tests, both typechecks clean.

## 1. What shipped (all uniform, RULE #0-clean)

- `@dario` — 4th seeded persona (`src/domain/agents.ts` ensureGlobalDefaultAgents):
  pi harness, `deepseek/deepseek-v4-flash`, thinking `low`, no tools, SOUL.md
  is the persona. `ensureDefaultAgent` gained a `configOverrides` param.
- `/thanks-dario [run|on|off]` (alias `/dario`) — commands.ts + COMMANDS
  registry + HELP section. `on` persists `RoomState.thanksDario`
  (normalizeRoomState whitelist!), surfaced as `snapshot.room.thanksDario`.
- Review: `RoomService.sanitizePreview()` — reads the replay window
  (`recentEvents(transcriptWindow)`), builds a strict-JSON task
  (`src/services/sanitize.ts` buildSanitizePrompt, events labeled
  `[event <id>]`), runs @dario through the ORDINARY summon path
  (`summonHost.summonAndWait` → sandboxed child room), parses + validates
  with parseSanitizeProposal — every suggestion's `quote` must be a verbatim
  substring of its event or it is DISCARDED (hallucinations can't corrupt).
  Junk replies degrade to `raw`+`parseError`. Proposal persisted at
  `<room>/sanitize.json`; marker on `snapshot.room.sanitize`.
- Apply: `RoomService.sanitizeApply(edits)` (409 while a turn runs) →
  `RoomHandle.redactEvents`: originals appended to `<room>/redactions.jsonl`
  BEFORE a same-line-count transcript rewrite (cursors stay valid), events get
  `redacted: true` (✂ tag), then `resetAfterTruncation()` (fresh sessions,
  capped cursors) — next turn replays sanitized history. NOTHING is deleted.
- HTTP: GET/POST `rooms/:id/sanitize`, POST `rooms/:id/sanitize/apply`.
- Web: `web/src/dario.js` popup (region "dario", `#overlay-dario`): summary,
  strategy-option chips, checkbox suggestions with red/green inline diff,
  Apply/Not-now; Escape + click-outside close; composer key/paste/focus
  guards; panic-stop Escape skips when the popup is open. Auto-trigger:
  committed room-event with `details.modelFallback` + room flag on
  (`maybeAutoDario` in events.js); `/thanks-dario` run pops via
  `syncDarioFromSnapshot` (sanitize.at change, room-switch-safe).
- Tests: commands parse, rooms redactEvents/whitelist, sanitize.test.ts
  (prompt+parse), room-service (toggle, preview via fake summon host, apply
  end-to-end incl. resets+cursors, error paths). README + memory updated.

## 2. Verified live

- Daemon restarted with the feature; @dario seeded on boot (agent.json ✓).
- Routes respond; `thanks-dario` in snapshot.commands; dario in agents.
- DeepSeek reachable through pi's own resolution (AuthStorage key from
  `~/.pi/agent/auth.json` + ModelRegistry `deepseek/deepseek-v4-pro` →
  completeSimple answered). Summon child room spawned with parent `nyari`.

## 3. OPEN INCIDENT — daemon wedge during the live E2E preview

Running the real preview (`POST .../rooms/nyari/sanitize`, home workspace
`181ac8fee51fa55f`, dario then on v4-pro/medium thinking) wedged the daemon:

- Event loop pegged at ~100% CPU for minutes; every HTTP request `http 000`.
- `sample` showed the hot path: `uv__stream_io → TLSWrap::OnStreamRead →
  ClearOut → JS microtasks` — i.e. the DAEMON was processing a DeepSeek TLS
  stream (Cloudflare 162.159.140.245:443, fd left open in state CLOSED).
- **No `__run-agent` subprocess existed for that summon turn** — the pi
  session appears to have run IN-PROCESS in the daemon. Investigate: where
  does a summon-room pi turn bypass RunnerHost? (RULE #0 smell + it puts
  provider streaming on the daemon's event loop, which is what made the wedge
  fatal.)
- Recovery: kill -9, stripped the poisoned `pendingTurn` from child room
  `dario-mr5hwaw60ov1gc` state.json (it would have resumed the same turn on
  boot), fresh daemon verified healthy/idle.

### TODO next session
1. Root-cause A: find the in-process pi path for summon turns (check
   room-service runtimeFactory wiring / createAgentRuntime vs any legacy
   in-process branch). Every harness turn must live in `gaia __run-agent`.
2. Root-cause B: the 100%-CPU spin — suspect quadratic/looping SSE buffer
   handling on a very long deepseek-v4-pro REASONING stream (thinking
   "medium" + 20 long nyari events). Reproduce OUTSIDE the daemon first
   (standalone script driving the same session), file/fix in the pi wiring.
3. Mitigations already applied: dario → `deepseek-v4-flash` + thinking `low`
   (live agent.json AND the seed in agents.ts). Consider also truncating very
   long events in buildSanitizePrompt (must only quote from included text!).
4. Re-run the E2E smoke: `POST /api/workspaces/181ac8fee51fa55f/rooms/nyari/sanitize`,
   inspect proposal, verify the popup + apply flow in the browser, and clean
   up junk `dario-*` child rooms afterwards.
5. Ari's upgrade (user-endorsed): REACTIVE targeting. We already capture the
   real `modelFallback` (from/to/reason) on the flagged reply — pass the
   confirmed-flagged event id(s) + reason into buildSanitizePrompt so Dario
   prioritizes ground truth over prediction ("the classifier ACTUALLY fired
   on the turn following event X — start there"). Predictive + reactive
   beats either alone.
6. INVARIANT (user + Ari, do not regress): suggest-only with human veto.
   The popup diff + checkbox approval is the product; never auto-apply, never
   delete originals. `/thanks-dario on` may auto-RUN the review, never the
   rewrite.
7. Commits on v2 remain unshaped (keep my strand separate from nyari's
   parallel /model + read-aloud work).
