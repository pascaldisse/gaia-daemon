# Reasoning menu clipping · 2026-09-09

§Cause → `.thinking-wrap` inside `.composer-meta { overflow: hidden }`; absolute popup outside metadata bounds → fully clipped. DOM existence ≠ visibility.
§Fix → `web/src/composer.js`: popup owner + UltraWhip sibling of text-clipping metadata; `web/src/css/composer.css`: thinking wrapper nonshrinking. Text truncation retained; reasoning API/levels/toggle semantics unchanged.
§Repro → owned `app-spawn.js` Chrome PID54306/CDP50527; real daemon8787, actual app; exact worktree composer JS/CSS via CDP Fetch interception. No fake snapshots/APIs; no OS input; native9333 passive only.
§Regression → `GAIA_TEST_CDP_PORT=50527 bun test test/composer-thinking.test.ts`; before0PASS/1FAIL, all5 options hit=false; after1PASS/0FAIL, all5 hit=true at1180×820 and390×820. Desktop both panes open; phone overlays dismissed. CDP mousePressed/released → menu open, outside dismissal, reopen. Runtime/console errors0. Screenshots inspected.
§Other gates → `bun run check` exit0 (knip advisory); `bun test web/src/reasoning.test.js`19PASS/0FAIL.
§Local raw → `.gaia/proof/{before,after,final-ui,check,reasoning}.log`; screenshots `.gaia/proof/{before,after}/reasoning-*.png`.
§Boundary → tested app against real daemon with candidate frontend assets; compiled runtime NOT changed. Native physical right-click + level persistence UNVERIFIED; source patch only, Pascal rebuild/reload pending. No room/agent settings written. Native console preexisting TAURI missing-callback warning retained in `.gaia/proof/native-console.log`.
