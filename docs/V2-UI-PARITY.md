# v2 UI parity — measured gap (2026-09-02)

Ref = `~/projects/gaia-daemon-v2/web/src` (app.ts 3008 · transcript.ts 778 · rich.ts 554 · settings.ts 918 · git-review.ts 1295 · styles.css 3540).
Target = this repo `web/src`.

## DONE (landed 09-02)
- tokens/themes: v2 palette set + `[data-theme]` blocks + preview/commit/revert + server-persisted theme setting.
- symbol vocabulary `glyphs.js`, all chrome emoji purged (incl. agent roster marks + activity kinds).
- tabbar shape (brand · numbered tabs · theme button), dictation chip, speaker mark per message.

## GAP (measured by class/marker grep — none present in v1)

### G1 trace + payload rendering  → LANE lampas
v1 = raw `call{…} args{…} result{…}` JSON dumps in `<details>`.
v2 = typed compact rows: `.trace` kind/summary/state + per-tool bodies
(`bashResultNode` cmd+exit-code · `readResultNode` line numbers + remainder
· `writeResultNode` byte count · `payloadSection`), plus `rich.ts`:
syntax highlight (`.syn-kw|str|num|com`), `jsonHtml` (`.j-key|string|number`),
word-level diff (`.diff-block/.diff-line/.diff-gutter`), `.code-block`,
`.mermaid-block`, `.box-table`, `.markdown-body`, `LazyRichRenderer`.

### G2 room shell  → LANE terra
`.room-header` (workspace + room paths, `.room-paths`) · `.room-search`
· `.room-meter` (ctx% + cost) · `.process-count` → `.process-modal`
(`.process-list`/`.process-row`/`.process-output`) · `.transcript-state`
· `.viewport` + `.split-horizontal|vertical` panes per tab.

### G3 composer  → LANE ghoul-codex
`.composer-meta-row`/`.composer-meta` (live model + thinking + meter while
running) · `.draft-status` + `.draft-conflict` (`.conflict-ranges`) ·
`.composer-attachments`/`.composer-attachment` · `.mic-button`+`.mic-level`
· `.retranscribe-button` · `.command-suggestions` · `.btw-toggle`/`.btw-panel`.

### G4 native sections + roster  → LANE ghoul-sonnet
`.todo-list`/`.todo-row` (+create/cancel) · `.question-card`/`.question-options`
(agent asks, human answers inline) · `.swarm-phase-tree` · `.roster-row`
· `.new-messages-chip` · `.time-separator` · `.unread-dot`.

### G5 settings/modals  → not yet assigned
`.settings-layout`/`.settings-nav`/`.settings-panel` · `.agent-settings-split`
· `.keymap-grid` · `.legacy-import-panel` · `.settings-table`.

### G6 git review pane  → DEFERRED (own feature, 1295 lines + server side)
`.git-review-pane` workbench: sources, file tree, structured diff, comment
cards, drafts, apply targets.

## Lane law
- CSS: each lane owns ONE partial under `web/src/css/`, linked from
  `web/index.html` (links already added — never edit index.html).
- JS: only the files listed for your lane. `styles.css` = nobody.
- Data missing in v1 daemon → report BLOCKED, never invent a fake source.
- Live proof: spawn your OWN daemon + `app-spawn.js` instance. Port 9333 =
  Pascal's screen, passive only.
