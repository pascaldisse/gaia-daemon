# Navigation / hover / rebuild source · 2026-09-08

§ Deployment cause
User rebuild12:01 → installed commit1c95554, sourceRoot stale linked lane chat-mtq974eg-jdk9; main alreadyfcca2ba. Live HTTP actions.js → navigation import absent; room-scoped snapshot GET404. Prior deployment pointer migration omitted; no browser-cache diagnosis.

§ Source repair
build-daemon → root=shared Git checkout; buildRoot=actual compilation checkout; commit/dirty retain compilation provenance. Source-top equality + candidate-top equality + recipe presence → reject enclosing repositories / unrelated separate-git-dir parents. Archive/non-Git → original source.
Existing installed manifest → root main, old buildRoot retained; compiled commit/builtAt unchanged. Production daemon29795/shell1298 unchanged; no restart/reload/input on user9333.
Signature procedure → cloned app first; outer-only signature FAILED (nested source.json signature); named-identity deep-sign + strictdeepverify PASS. Actual app same procedure PASS; designated requirement unchanged.

§ Baseline reproduction
Owned compiled daemon61785 + app-tools browser61875; visible1440×900. 1188 copied room metadata records + 3 copied-transcript fixture rooms; pending turns/queues not copied. Real CDP hover + five same-room POST/select broadcasts → original hovered row detached/hoverfalse/identityfalse ALL5. No OS cursor input.
1191-room fixture navigation diagnostic, existing navigation fix → uncached127ms; cached20–60ms; delayed700ms race client/serverB/B. Source-only fixes not yet evidence for user WKWebView.

§ Real rebuild
Owned browser composer → /rebuild submitted to daemon61785; actual graceful close/build/swap/re-exec → daemon34930 at64860 (ephemeral port). New manifest → root=buildRoot=shared checkout, commit8cf2165, dirtyfalse. Production29795/1298 untouched. Future-build source prevention8cf2165 FF-landed main; actual user build still1c95554 until user rebuild.

§ Evidence
Private logs/scripts/copied transcripts → room worktree .gaia/navigation-proof/. Raw user content excluded from committed evidence.
Build-source3 / bundle-assets9 / navigation17 / select-room-race1 / ordered-blocks4 / tabs3 PASS; bun run check PASS. First archive test exposed enclosing-Git-root discovery → source-top equality guard; retained test now PASS.
§ Rejected intermediate sidebar
89bbc22/f1b260a → unchanged snapshot preserves hovered node; actual title update still detaches it (connected/hover/identityfalse). Parent blocked landing; changed rows require in-place attribute/text/listener patch.
Background roomA /help → hoveredB stays connected but moves259→284.75; A replaces target under stationary pointer. Parent blocked landing; defer automatic activity reordering during hover, release on leave; status/selection updates remain live.
§ Final sidebar / compiled-browser acceptance
fe6f1a4 → persistent button + mutable handler data; in-place title/status/selection updates. 66e316f → sibling-order hold at every depth; native focus restored after intentional DOM moves; optional incognito spacing retained; drag order derives from held display order. Initial hovered sidebar detected on listener binding.
Own compiled UI at55533 → 10/10 same-snapshot/title/activity/background updates: identity/connected/hover/focus true; fixed Y. Nested real /help → hovered child held at387.75px, release moves362px; native focus + identity retained. CDP drag while natural/display orders differ → client/server[b,a,c], same button, capture released, zero dragging nodes. Real right-click menu PASS; Meta-click → second tab c, no error.
Merged-main compiled bundle2cb3b5a → owned daemon66829 at60768; same browser61875. Final10/10 hover assertions PASS atY310.5; title fresh + unread dot live. Cached room/workspace paint33–92ms; sampled cold room settlement101/133ms; earlier heavy-room first visit233ms. Delayed700ms race client/serverB/B; injected503 rollbackB + event channel live; rapid cross-workspace last-intent PASS; transcript event IDs match independent room snapshot GET.
Lazy trace → closed bodies0; tool/thinking expansion PASS; same body on reopen; restored across navigation. Screenshot inspected; no console/runtime exceptions in monitored acceptance window.
Gates after merging main → check PASS; sidebar-hover8 + reconcile10 + navigation17 + build-source3 + bundle-assets9 + select-room-race1 + ordered-blocks4 + tabs3 =55 PASS/0FAIL; files run individually.

§ Production boundary
At12:35 previous production PIDs absent, replacement daemon49863 observed; installed commit still1c95554. Owned34930 exited via inherited shell-parent watcher; subsequent owned spawns omit shell-parent environment. No assistant restart/kill of production. Updated UI in user's WKWebView remains UNVERIFIED until user rebuild; canonical source pointer repaired + strict signing verified.
Raw proof → .gaia/navigation-proof/{hover-merged-final,acceptance-merged-final,nested-hover-final,nested-release-final,drag-final,expand-merged-final,console-merged-final}.json; screenshots private.
