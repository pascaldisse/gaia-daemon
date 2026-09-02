# ARCHTREE — Integrationsplan

Status: Plan; kein Deploy in laufende App; kein Daemon-Start/-Stop/-Restart.

## Gemessener Lieferweg

- `scripts/build-daemon.mjs` kompiliert `src/cli.ts` → `gaia-daemon`; danach Snapshot jedes Eintrags aus `BUNDLE_ASSET_DIRS` nach `<out>/<name>`.
- `src/core/bundle-assets.ts` setzt `BUNDLE_ASSET_DIRS = ["web", "setups", "design", "addons", "vendor", "plugins"]`; `web/` ist vollständig enthalten. Kein Einzelasset-Manifest.
- `src/core/paths.ts:147-161`: Laufzeit löst `bundledDir("web")` neben Binary/Resources auf.
- `src/server/http.ts:627-631`: alle Nicht-`/api/`, Nicht-`/v1/`-Pfade → `serveStatic`.
- `src/server/http.ts:2018-2050`: `serveStatic` liefert Dateien unter `web/`; fehlende Datei → `web/index.html`; Cache-Control `no-store`; HTML-Rewrite nur Base-Path für `/src/` und `/vendor/`.
- Einstieg bereits real: `web/src/sidebar.js:113-120` lazy-importiert `./archtree/index.js`; Styles liegen in `web/src/styles.css`; `web/index.html` lädt `/src/main.js` und dessen ESM-Graphen.

## Benötigte Dateien

- `web/src/archtree/index.js`, `model.js`, `layout.js`, `params.js`, `port.js`, `renderer.js`, `theme.js`.
- Bestehende Einbindung: `web/src/sidebar.js`, `web/src/styles.css`.
- Tests: `test/archtree-model.test.ts`; nicht Laufzeit-Asset.
- Kein Manifest-Eintrag, keine neue statische Route, kein npm-Paket, kein Binary-Zusatzartefakt.

## Rollout — später, getrennt

1. Arbeitsbaum prüfen: Archtree-Module, Sidebar-Lazy-Import, CSS, Tests vollständig.
2. `bun run check`; `bun test test/archtree-model.test.ts`.
3. Paketbuild in Staging: `bun scripts/build-daemon.mjs --out <staging>`.
4. Staging prüfen: `<staging>/web/src/archtree/*`, `<staging>/web/src/sidebar.js`, `<staging>/web/src/styles.css`, `gaia-daemon`, `gaia-source.json`.
5. Freigabe: neuer Prozess-/Release-Rollout nur nach explizitem Betriebsauftrag; dieses Dokument deployt nichts.
6. Nach Rollout: Browser-Neuladen; 🌳 öffnen; Live-Status, Navigation, Close/GL-Ressourcen manuell prüfen.

## Rücknahme — später, getrennt

1. Vorheriges signiertes/validiertes Paket bereithalten.
2. Rollback durch Austausch des gesamten vorherigen Paketstands: Binary plus gesnapshottetes `web/`; keine Einzeldatei im Live-Bundle mischen.
3. Prüfen: alte `web/`-Version und Binary/`gaia-source.json` konsistent; Browser-Neuladen.

## Risiken

- `web/` ist unhashed und `no-store`; trotzdem können offene Tabs noch geladenes ESM halten → Reload erforderlich.
- Static-Fallback auf `index.html` maskiert fehlende Modul-URLs als HTML-Importfehler; Staging-Dateiinventar prüfen.
- Base-Path-Rewrite deckt `/src/` und `/vendor/`; neue root-relative Assetpfade außerhalb dieser Muster vor Rollout prüfen.
- `renderer.js` braucht WebGL2; nicht unterstützte Browser zeigen die explizite Unavailable-Meldung.
- `/rebuild` kann Paket-/Prozesswechsel auslösen; nicht Teil dieses Plans und hier ausdrücklich nicht auszuführen.

## Abnahme

- Paket enthält vollständiges `web/src/archtree/` und bestehende Sidebar/CSS-Änderungen.
- Daemon liefert `/src/archtree/index.js` sowie transitive Module aus `bundledDir("web")`.
- 🌳 öffnet Ansicht; `state.snapshot.rooms` treibt sichtbaren Status nach Reload/Events.
- Klick navigiert über `selectRoom(workspaceId, roomId)`; Close beendet rAF und disposes WebGL.
- `bun run check` und `bun test test/archtree-model.test.ts` grün.
- Kein Deploy in die laufende App durch diesen Plan oder Dokumentationscommit.
