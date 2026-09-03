# W3 pass 5c compiled live · 2026-09-03

- base → `4333462`; worktree → `room/chat-mtk78q14-wa40`; port → `18787`.
- compiled binary → `.gaia/livetest-dist/gaia-daemon`; build rc → `0`; 79,363,682 bytes.
- run root → `.gaia/live-test-runs/pass5c-20260903022428`; isolated `GAIA_HOME` + initialized `.gaia/livews/.gaia/config.json`; daemon cwd → livews.

## Case 3 · staged manifest boundary

**FAIL — PASS5C-001.**

- same already-open `default` room → v1 `/probe inflight` began on generation 1.
- fixture disk replacement → v2 manifest + entrypoint; only `POST /api/plugins/reload` → HTTP `200`, `status:"staged"`, generation 2.
- release → held v1 completed on generation 1; boundary swap + one v1 disposer observed.
- same room next `/probe next` → generation 2, but still executed v1 code: `V1 enter generation=2 args=next`; no `V2 enter`.
- lifecycle order → `staged=1 → swapped=1 → staged=2 → swapped=2 → disposed=1`; v1 disposer count → `1`.
- evidence → `probe-inflight.{http,json}`, `reload.{http,json}`, `probe-next.{http,json}`, `manifest-executions.log`, `case3-assertions.txt`, `case3-transcript.jsonl`, `daemon-lifecycle-final.log`, `daemon.log`.

## Case 4 · A16 edit/resend

**PASS.**

```sh
GAIA_LIVE_EDIT_RESEND=1 LIVE_WORKSPACE_DIR=<worktree>/.gaia/livews GAIA_PORT=18787 \
  bun test --timeout 240000 test/edit-resend-live.test.ts
# 5 pass · 0 fail · rc 0
```

- real Luna OAuth turn landed: `author:"luna"` token replies.
- active transcript → edited token present; old tail absent; rewound + Pi fork-chain assertions passed in the live test.
- evidence → `case4-test.log`, `case4-exit.txt`, `final-transcript.jsonl`, `case4-rewound.jsonl`, `case4-pi-sessions/`, `case4-token-transcript.txt`.

## Cleanup

- daemon stopped; `livetest-dist`, `livehome`, `livews` removed.
- final port/process evidence → `lsof-after-final.txt`, `orphan-sweep-final.txt`.
