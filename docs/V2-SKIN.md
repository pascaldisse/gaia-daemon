# V2-SKIN — v1 web UI → v2 look (the redesign, not the glyphs)

P 09-02: "still looks like the old interface. v2 = much more minimalistic." Lampas ported symbols/themes/components (§V2-UI-PARITY) → skin untouched. This spec = skin.

## LAW (binding, quoted — violations = bugs)
Source: ~/projects/gaia-daemon-v2/docs/handoff/01-DESIGN-LAW.md + 02-LAYOUT.md · mockup: ~/projects/gaia-daemon-v2/docs/design/mockup.{html,css,js} (REFERENCE_TASTE + STRUCTURE) · v1 skin = REFERENCE_ANTI (reproducing its scale/skin = failure).
- 12.5px base · 22px trace rows · 24px sidebar rows · mono stack `"0xProto Nerd Font","FiraCode Nerd Font","JetBrainsMono Nerd Font",ui-monospace,Menlo,monospace`.
- Flat 1px borders. `border-radius:0` everywhere. NO box-shadow (sole exception: `.tab.active` inset accent line). NO gradients · NO hover-lift · NO OS cosplay.
- Zero vertical rules in transcript (no border-left strips, no gutter │). Attribution = header + containment.
- Selection = `--sel` shade. Time separators `── HH:MM ──` (`.separator` in mockup.css).
- Caret `▌` ONLY in composer.
- Color semantics exclusive: accent=agent identity/headings · accent2=tool names/links · good=success/diff+ · warn=labels/numbers/running · alert=errors/diff− · dim=machinery (traces/timestamps/paths/system). No hex outside theme blocks.
- Speaker names plain: `☾ nyari` never `@nyari` header; human = name (`pascal`/userName), never "you". `@` = addressing only (targets).
- Entry shapes (mockup.css §entries): `.entry.user` = shaded `--sel` strip, `margin-left:10ch`, bold name, `❯` accent glyph, target dim · `.entry.agent` = glyph(2ch)+accent name header, body `margin-left:3ch`, `max-width:96ch` · `.entry.system` = dim italic 11px notification line, expandable.
- Chrome: tabbar 30px (◆ GAIA brand 14ch · tabs w/ `.tab-num` boxed number · `+` · ◈ theme btn right) · sidebar 28ch (search 26px → WORKSPACES → ROOMS nested subs `padding-left:3ch` → settings pinned bottom) · room header 46px (path strong + transcript path small dim · ⌕ · active-agent meter accent) · room panel 32ch (Room header · talk toggle · AGENTS roster `.roster-agent` 2-row 38px grid) · composer 76px (`.compose-input` 30px 1px border · `.compose-meta` 11px dim below).
- **No bottom status bar** (02-LAYOUT: killed by operator, stays dead). Its survivors relocate: theme ◈ → tabbar · usage % + artifacts → room-header-controls · rest dropped.
- Themes: ALL 13 palettes kept (themes.js / [data-theme]); every surface recolors via vars.

## Repo laws riding along
- BUN ONLY (never node/npm/npx). Gate = `bun run check` (from lane worktree; `git submodule update --init` first if design/ empty).
- Worktree = yours only, root = merge-only. `git -C <abs>` always. Commit per stage.
- No /tmp scratch → `~/lab/<lane>/`. Sweep own processes on close.
- LIVE TESTS SERIALIZED (CPU-Gesetz): lanes = code + gate + commit ONLY. NO daemon spawn, NO browser in lanes. Monad runs ONE merged live verification after all land.
- web/src = JSDoc plain .js, strict checkJs. No runtime src/ imports.
- No fabricated data: missing data source → BLOCKED line in report, no fake UI.

## Ownership (disjoint — touch nothing else; conflicts = your bug)
Base: branch `gaia/chat-mtk77l0h-onob` @ `820e568` (= main). Lane branch `v2skin/<lane>`, worktree `.gaia/worktrees/v2skin-<lane>`.
CSS partials load AFTER styles.css (web/index.html — verify link order; add your partial there if missing: ONE line, your own file).

| lane | owns | forbidden |
|---|---|---|
| frame | `styles.css` §base/tokens/frame/tabbar/sidebar/statusbar/scrollbars/focus/modal-backdrop · `render.js` · `sidebar.js` · `tabs*.js` · `statusbar.js` (kill) · `keys.js` (theme key) · `web/index.html` font links · `web/fonts/` | transcript/composer/panel/settings sections of styles.css |
| transcript | `styles.css` §transcript/entry/markdown/codeblock sections (delete v1 rules there) · `css/transcript.css` (new) · `transcript.js` · `css/trace.css` (22px rows) | everything else |
| room | `css/room.css` · `css/composer.css` · `css/native.css` · `statusbar.js` room-header part ONLY (room header lives there — coordinate: frame lane kills the FOOTER render only; you edit header render) · `composer.js` · `panel.js` · styles.css §composer/§panel sections (delete v1 rules there) | sidebar, transcript |
| settings | `settings.js` · `css/settings.css` (new) · theme palette overlay (`statusbar.js` palette render fn ONLY) · styles.css §settings/§palette/§modal-body sections (delete v1 rules there) | everything else |

styles.css: delete/replace ONLY inside your sections; never reformat/reindent; never touch other sections' lines (hunk-adjacency = merge conflict).

## Per-lane acceptance
### frame
- body 12.5px/1.5 mono stack; `*{box-sizing}`; flat scrollbars; `:focus-visible` 1px accent.
- `.app` grid `30px minmax(0,1fr)`; shell `28ch 1fr 32ch` (keep v1 resize handles if present, restyled flat).
- Tabbar per mockup (`.brand`,`.tab`,`.tab-num`,`.tab.active` inset line,`.tab-new`,`.theme-btn` ◈ → opens existing palette).
- Sidebar per mockup: 24px rows, transparent border, `.selected/.active` = accent border + `--sel`; dots 6px squares; subs `padding-left:3ch`; `settings` pinned bottom (`.side-bottom`); no boxed buttons, no `★` boxes, "show N more" as dim text row.
- Statusbar: footer NOT rendered (region returns nothing / element hidden + `initStatusbarPref` no-op); Ctrl/Cmd keys that targeted it keep working or are removed with note.
- Fonts: if `~/projects/gaia-daemon-v2/web/**/*.woff2` exists → copy to `web/fonts/` + `@font-face`; else stack only + report.
- grep gate in your sections: `border-radius` 0 · `box-shadow` 0 except `.tab.active`.
### transcript
- Entry header/body per LAW entry shapes; timestamps right, dim 10px; speaker plain name (strip `@`), targets `→ @x` dim; human name = snapshot userName / event author.
- `── HH:MM ──` separators (insert when minute changes between consecutive entries; mockup.js shows logic).
- Trace rows 22px grid `3ch max-content minmax(8ch,1fr) max-content`; kind color law (tool=accent2 · skill=accent · thinking=dim italic); `.trace-body` `--sel` bg, `margin-left:3ch`, max-height 280px.
- Markdown/codeblock per mockup.css §rich (h1 14px h2 13px accent; code `--sel` bg good; tables th uppercase 10px).
- No centered speaker labels, no card borders around entries, no border-left strips.
- grep gate in your sections: radius 0 · shadow 0 · `border-left` only in blockquote.
### room
- Room header 46px per mockup `.room-head` (path strong / transcript path small dim / right: ⌕ box · usage% · artifacts btn · active agent accent).
- Composer per mockup: `.compose-input` 30px 1px border, caret accent, send ▸ accent right; `.compose-meta` 11px dim (glyph name · #thinking model ctx% left · ⌁ mic right). Existing meta-row/attachments/suggestions restyled flat; running banner → one dim line, stop `◼` alert text, no red box.
- Room panel: `.panel-head` (Room accent + path dim) · `.talk` · AGENTS h2 10px letter-spaced · `.roster-agent` grid per mockup.css (glyph col · name+model 2 rows · 2 tiny 16px selects · star col). No card borders, no per-agent boxes.
- native.css sections (todo/swarm) flattened to law.
- grep gate: radius 0 · shadow 0 in your files.
### settings
- Modal per mockup: 820px, 1px border, `.panel-head` accent h2 + × · `.segmented-tabs` · `.settings-body` `.field-row` grid `22ch 1fr` w/ 1px bottom border · custom 12px square checkbox · agents tab `.settings-split` walker nav · accounts `.account-row`.
- Theme palette overlay `.modal.palette` 340px `.theme-row` + 5 swatches (bg fg dim accent good); hover preview/commit/revert behavior unchanged.
- grep gate: radius 0 · shadow 0 in your files.

## Report format (each lane, ≤25 lines)
branch+commit · files touched · `bun run check` exit · grep gate counts · BLOCKED lines · nothing else.
