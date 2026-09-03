# Refactor pass 4 live

## W3 live execution

### 2026-09-03 · compiled live run · FAIL

- build tree → `a9550fbb75b05e175f3b58e448df41d29a7bfc47`; source tree = `338db79` + pass-4 docs only. `git diff --name-only 338db79..a9550fb` → docs only; `72bf6a8`/`9d649ff` ancestor checks → rc `1`/`1`. Build-log mtime `01:24:17`; forbidden commits `01:26:12`/`01:26:47` → excluded. Current `b9ee54b` contains them; no build/test after their arrival.
- seed/build/start → `GAIA_HOME=<run>/home`; copied `agents/luna`, `accounts.json`, `config.json`; initialized `<run>/ws/.gaia/config.json`; `env -u GAIA_PARENT_PID GAIA_HOME=<home> GAIA_PORT=18787 <run>/dist/gaia-daemon`; cwd=`<run>/ws`; port precheck rc `0`, empty; compiled `bun run build --out <run>/dist` rc `0`; app `GET /api/app` rc `0`.
- run root → `/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40/.gaia/live-test-runs/pass4-20260903012416`; generated `dist`/`home`/`ws` removed.
- A16 opt-in → `GAIA_LIVE_EDIT_RESEND=1 LIVE_WORKSPACE_DIR=<run>/ws GAIA_PORT=18787 bun test --timeout 120000 test/edit-resend-live.test.ts`; rc `0`; `5 pass · 0 fail`; live token transcript/rewound/Pi evidence → `<run>/evidence/a16-transcript.jsonl`, `<run>/evidence/a16-rewound.jsonl`, `<run>/evidence/a16-pi-sessions`.
- cleanup → daemon killed; `lsof -nP -iTCP:18787 -sTCP:LISTEN` → `listener-empty`; run-root orphan filter → `orphan-empty`; evidence → `<run>/lsof-after.txt`, `<run>/orphan-sweep.txt`, `<run>/daemon.log`.

### LIVE-P4-001 · P1 · registry command transcript/denial observability

- base → `338db79`/`b98c3ce`; build tree `a9550fb`; no fix.
- repro → trusted Luna + workspace/agent `network` grant; `POST /api/workspaces/<id>/rooms/default/messages {"text":"/probe trusted"}` → HTTP `202`, task `complete`, fixture marker `entered generation=1 args=trusted`. `trust:false`; same request `/probe untrusted` → HTTP `202`, task `complete`; marker lines `1 → 1`.
- expected → command reply/provenance persisted in transcript; denial explicit in transcript/log; untrusted contribution code absent.
- actual → code gate holds; marker unchanged. Both `events`/`transcript` empty; no denial log; HTTP presents completed task. Bundled `plugins/defaults/plugin.json` declares `commands:[]`, so required bundled-command turn is unreachable; generated manifest fixture was the only registry invocation.
- evidence → `<run>/probe-trusted.json`, `<run>/trusted-marker.txt`, `<run>/probe-untrusted.json`, `<run>/marker-count-before-denied.txt`, `<run>/marker-count-after-denied.txt`, `<run>/transcript-after-allowed.jsonl`, `<run>/events-after-allowed.json`, `<run>/daemon.log`.

### LIVE-P4-002 · P1 · manifest change never stages in live daemon

- base → `338db79`/`b98c3ce`; build tree `a9550fb`; no fix.
- repro → boot fixture manifest `1.0.2`; start held `/probe inflight`; replace manifest/entrypoint with `1.0.3`; wait; send `/probe next`.
- expected → old generation completes; boundary swaps; next uses `1.0.3`; old disposer once at swap.
- actual → HTTP `202`/`202`; markers `V102 entered generation=1 args=inflight`, `V102 entered generation=1 args=next`; no live stage/swap/dispose. Only final shutdown emitted `PASS4-PROBE V102 dispose generation=1`.
- evidence → `<run>/probe-inflight.http`, `<run>/probe-next.http`, `<run>/manifest-executions.txt`, `<run>/evidence/manifest-after-change.json`, `<run>/daemon.log`.
