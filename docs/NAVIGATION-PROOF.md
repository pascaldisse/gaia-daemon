# Navigation · 2026-09-05

§ Scope
Room/workspace switching → shared latest-intent epoch + abort/deadline; session-only bounded LRU → synchronous revisit adoption; rejected optimistic chains → last confirmed room.
SSE → closed-channel guard + room-scoped read-only resync; history paging → generation/pager ownership.
Sidebar → click-time selection, not rendered isCurrent; pending departure → current-room click remains actionable.
Daemon → per-workspace ordered selection mutation; independent snapshot/file reads outside queue; stale broadcasts suppressed; read route membership gate.

§ Commits
Client fde5df7; sidebar 686e443; server lane through c1177cd; integration 12182c6 (main 5a68484).

§ Compiled-app proof
Isolated daemon :62594 + app-tools headless CDP :19345; user :9333 → passive info only, no navigation/restart/input.
Fixture → two workspaces, three copied transcript rooms + referenced attachments; no model turns.
Desktop 1440×900 → cached room paints 52–134 ms; cached workspace paints 33–83 ms; synchronous state adoption before refresh.
First uncached room visits → 83–110 ms settled in this fixture; no universal instant-first-load claim.
700 ms delayed older response → client b / server b; injected 503 → rollback b + error + reconnected channel; same-frame room/workspace chain → final one/b; transcript IDs match room-scoped GET.
Evidence → navigation-proof/{desktop,console}.json; screenshot visually reviewed.
Console → CDP Runtime/Log capture: exceptions 0, console errors 0, network errors 0. app-console /console unavailable on Chromium spawn; direct CDP capture used.
Private raw scripts/logs/screenshots/fixture → worktree .gaia/navigation-proof/run-0905/ (ignored; no copied transcripts committed).
Owned browser/daemon → closed after proof; transient duplicate headless browser → closed before tests.

§ Gates
bun run check → exit 0; existing knip advisories.
bun test --preserve-symlinks test/web-navigation.test.ts → 17 pass (design/web browser-relative mount requires symlink preservation).
bun test test/select-room-race.test.ts → 1 pass; actual HTTP + held mutation/response reads + durable config/current-room checks + rejection recovery + membership.
bun test test/room-membership-security.test.ts → 6 pass.
bun test test/http-routes.test.ts → 9 pass.
bun test test/http-user-workspaces.test.ts → 1 pass.
bun test test/web-tabs.test.ts → 3 pass.
bun test test/room-service.test.ts → 106 pass / 1 FAIL: pre-existing stalled-turn requeue timeout; also fails isolated with --timeout 15000. Earlier baseline 059793b reproduced same timeout. Full room-service gate NOT green.

§ Landing
Room branch committed; root untracked proof/ → merge-only clean-root gate blocked; unrelated files untouched.
User live deployment → UNVERIFIED until landing + user /rebuild.
