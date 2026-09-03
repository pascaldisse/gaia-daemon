# W3 pass 5b compiled live rerun · 2026-09-03

- base → 62fdfe8; branch → live/pass5b; compiled binary → 79,363,682 bytes.
- run root → `.gaia/live-test-runs/pass5b-20260903020808`; isolated GAIA_HOME + workspace `.gaia/config.json`; port 18787.
- build → `bun run scripts/build-daemon.mjs --out <worktree>/.gaia/livetest-dist` → rc 0.

## Verdicts

1. **PASS** — `/dog`, `/stfu` → durable dog `kind=plugin-reply`, user `/stfu`, Luna reply + render cap. Evidence → `v1-transcript.jsonl`, `v1-state.json`, `_dog.response.json`, `_stfu.response.json`.
2. **PASS** — fixture `acme.probe`, cap `probe.act`; Luna grant → durable `plugin-reply` `V100 probe trusted-settings`; `trust:false` untrusted-probe → durable `capability-denied`, `details.pluginDenial={pluginId,capability,agentId,reason}`; marker stays one enter line; daemon denial log present. Evidence → `v3-transcript.jsonl`, `v2-untrusted-direct-transcript.jsonl`, `v2-marker-final.log`, `v2-untrusted-direct-daemon.log`.
3. **UNVERIFIED** — POST reload staged/swap observed; open RoomService retained generation-1 command map until settings-file PUT reload. No held-v1→v2 lifecycle proof. Evidence → `v2-reload.json`, `v2-daemon.log`, `v3-settings.json`, `v3-daemon.log`.
4. **FAIL** — `GAIA_LIVE_EDIT_RESEND=1 LIVE_WORKSPACE_DIR=<worktree>/.gaia/livews GAIA_PORT=18787 bun test --timeout 120000 test/edit-resend-live.test.ts` → rc 1, 4 pass/1 fail, transcript wait timeout. Evidence → `a16-test.log`, `a16-exit.txt`.
5. **PASS** — pendingTurn observed → SIGKILL → same compiled binary restart; recovery log `pending=true, queued=0`; valid JSONL, 11 unique IDs; crash token one user event + one ACK reply; no pendingTurn post-recovery. Evidence → `v5-state-before-kill.json`, `v5-state-after-restart.json`, `v5-transcript-after-restart.jsonl`, `v5-analysis.json`, `v5-daemon.log`.

## Tickets

- PASS5B-001 → A16 opt-in compiled live timeout; no fix.
- PASS5B-002 → POST plugin reload does not refresh an open RoomService command map; held-turn lifecycle incomplete; no fix.

## Cleanup

- generated `livetest-dist`, `livehome`, `livews` removed.
- final listener/orphan evidence → `lsof-after-final.txt`, `orphan-sweep-final.txt`.
