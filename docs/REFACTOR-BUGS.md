# Refactor adversary tickets

Scope → `main` + active `wip/*` / `room/*` refactor atoms · fixes forbidden · evidence from isolated adversary worktrees.

## ADV-001 · BLOCKER · `wip/a0-compact-clean@97e4c24` must not merge

Atom → root-WIP preservation commit `97e4c24` (`5502e39..97e4c24`) · 16 files · +486/−88 · multiple unrelated behavior changes.

Defect → committed conversation-ending feature deleted while daemon endpoint remains wired:
- `src/services/room-service.ts` → `RoomService.endConversation()` + suppression/reactivation paths removed
- `src/daemon.ts:1098` → surviving `service.endConversation(...)` call
- result → compile failure + live endpoint regression

Repro:
```sh
R=/Users/pascaldisse/projects/gaia-daemon/.gaia/worktrees/chat-mtk78q14-wa40/.gaia/review-97e4c24
cd "$R"
bun run check
bun test test/room-service.test.ts
bun test test/end-conversation.test.ts
```

Expected → check exit 0 · room-service 98/0 · endpoint 1/0 and HTTP 200.

Actual @ `97e4c24`:
- check exit 2 → `src/daemon.ts(1098,20): TS2339 Property 'endConversation' does not exist on type 'RoomService'`
- room-service → 95 pass / 2 fail · `service.endConversation is not a function`
- endpoint → 0 pass / 1 fail · HTTP 400 ≠ 200

Independent control @ `main@dc2c552` + docs-only review commits → room-service 98/0 · endpoint 1/0.

Boundary → preservation branch only; never merge/cherry-pick wholesale. Extract independent intended changes into bounded atoms + own tests.

## ADV-002 · HIGH · `main@dc2c552` adds untested `compact-clean` wire path

Atom → A0 `dc2c552` · `src/harness/{host,protocol,runner,spec}.ts` · +24/−1.

Defect → new runtime protocol branch has zero test reference; existing RunnerHost test covers only ordinary `compact`:
```sh
git -C /Users/pascaldisse/projects/gaia-daemon grep -n -E 'compactClean|compact-clean' dc2c552 -- test web/src/'*.test.js'
```
Expected → tests assert host command framing, runner dispatch, progress/result forwarding, unsupported-runtime error.
Actual → zero matches.

Gate replay @ review branch `7cd43bb` (contains exact `main@dc2c552` + docs):
- `bun run check` → exit 0
- `bun test test/runner-host.test.ts` → 18 pass / 0 fail
- `bun test test/runner-host-proxy.test.ts` → 2 pass / 0 fail

Risk → type seam proven; live behavior/error framing unproven. No live slot required for A0, but focused regression coverage remains mandatory before clean adversary verdict.

## Known planned debt · non-ticket

- A1 layering baseline → `src/harness/tools-pi.ts:12-15` imports four `src/services/*` modules upward.
- W1 owns removal; not introduced by A0 `dc2c552`.
- RULE0 literal harness-id branches introduced by reviewed atoms → none.
