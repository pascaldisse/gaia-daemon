# Edit/resend live test — v1 (2026-09-02)

Setup: ephemeral daemon (livetest build of room branch @ `7e5e31d`), own GAIA_HOME, port 18787, workspace `.gaia/tmp-livetest-20260902-164146` · agent luna (openai-codex/gpt-5.6-sol) · tokens as exact-reply probes · truth read from disk (transcript.jsonl · rewound.jsonl · pi-sessions/*.jsonl), not API.

## Q1 — history source = pi session only?  → YES
- turn ≥2 prompt = `New room events since your last turn:` + exactly 1 event (the new one); no transcript replay. Counted per entry: events-in-prompt = 1 for every user entry.
- persistent-memory block only on session-first prompt.

## Q2 — edit/retry: old tail re-sent?  → NO (fixed)
Run A (room `default`): U1 A1-LIVE → U2 A2-OLD → U3 A3-TAIL → edit U2 → retry A1.
- edit U2 → new user entry `fb0f5035` parentId = `c65a9241` (A1 assistant) → pi tree fork; A2-OLD/A3-TAIL entries stay in file off-branch, never in prompt. Actual prompt = A2-EDITED only. Reply `A2-EDITED`.
- retry A1 → user entry `4586c5a0` parentId = `be655756` (pre-A1 thinking_level_change) → correct root.
- room events after edit = 4 (U1,A1,U2',A2') · rewound.jsonl holds U2,A2,U3,A3 then U1,A1 (retry) → consistent.
- mechanism = `forkAtMessage` (single session file, parentId rewire); no WAL replay observed.

## Q3 — mixed turns then edit → ordinal lands?  → YES
Run B (room `q3`): U1 Q3-A1 → U2 → luna replies `@ghoul-sonnet Q3-HANDOFF` → edit U1.
- edit U1 → user entry `f77c4c26` parentId = `5414d434` (session root) — skips A1/U2/handoff entries; prompt = 1 event; reply `Q3-A1-EDITED`; transcript = 2 events; rewound = 4.
- Run A also: after luna→ghoul-sonnet handoff turn (entries 13/14) next user entry parent = handoff assistant → chain intact.
- ⚠ UNVERIFIED side-observation: run B the `@ghoul-sonnet` mention produced NO ghoul-sonnet turn (no session, no turn-failed, activeAgent stayed luna); run A the same mention DID trigger a turn (died on Connection error). Cause not isolated (creds in ephemeral home? membership?) — not an edit/history bug; log as follow-up.

## Incidents
- lane 2 (terra) died: ChatGPT pool `Unable to connect` mid-lane — captures survived.
- lane 2b (sonnet) died: live daemon restart → ephemeral daemon inherited `GAIA_PARENT_PID` → `parent GAIA shell gone — exiting`. Fix for future live tests: `env -u GAIA_PARENT_PID …` (done run B).
- `~/.gaia/gaia-tld/bin/proxy.mjs` runs under node (pid 788) → AGENTS.md bun-only violation → hygiene wave A2.

## Verdict
v1 = pi-history-only · edit/retry fork correctly · no old-tail leak · mixed agent turns don't desync the fork target.
