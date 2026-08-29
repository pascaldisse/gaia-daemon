# ARCHTREE VISUALIZER — DESIGN

Status: design (v1 scope frozen). Lane: `archtree-visualizer`. Repo: gaia-daemon.

## 0. Recon (真, measured in repo)

| Frage | Befund | Datei |
|---|---|---|
| Room-Baum-Datenquelle | `RoomSummary { id, path, parentRoomId?, running?, title?, favorite?, incognito?, lastActivity? }`, Snapshot liefert `rooms` flach + `workspaceRooms` | `src/core/types.ts:1090`, `web/src/types.js` |
| Parent→Child-Kanten | Summon setzt `parentRoomId: this.roomId` beim Spawn | `src/services/room-service.ts:3144`, `src/services/summons.ts` |
| Vorhandene Baum-UI | Sidebar rendert bereits rekursiv `childrenOf`-Map, unbounded nesting | `web/src/sidebar.js:235-331` |
| Room-Navigation | `selectRoom(workspaceId, roomId)` → snapshot + Tab öffnen | `web/src/actions.js:123` |
| Live-Updates | SSE `UiEvent` → `markDirty(region)`, Regional-Renderer mit rAF-Flush | `web/src/render.js` |
| Plugin-Mechanismus (Daemon) | zwei Systeme: (a) Command-Plugins `.mjs` (`src/services/plugins.ts`) — **data-only Panels, explizit KEINE iframes / keine eigene UI-Fläche** (Kommentar `PluginPanel`); (b) Package-Plugin-Host (`src/services/plugin-host.ts`) — registriert **services**, kein UI, kein HTTP/Room-Zugriff | s. Dateien |
| GWE-Web-Client | Vite + `three@0.180`, eigener Kernel/Extensions, kein einbettbares Widget-Build, keine stabile Embed-API | `~/projects/GAIA-World-Engine/package.json`, `client/` |

### Konsequenz (死-Zweige, mit Begründung)

- **死 „als Command-Plugin bauen“** — Grund: `PluginPanel` ist deklarativ data-only und der Kommentar verbietet ausdrücklich, dass ein Plugin eine eigene Browser-Fläche (iframe) in der Room-UI einbettet. Ein WebGL-Baum ist darüber nicht darstellbar. Nicht umgehbar ohne Core-Bruch.
- **死 „als plugin-host Package-Plugin“** — Grund: registriert nur `services`, hat per Design null UI/HTTP-Autorität.
- **定 v1 = Web-Client-Feature-Modul** unter `web/src/archtree/*`, self-contained, gekoppelt an den Core nur über **drei bestehende, generische Erweiterungspunkte**: `registerRegion("archtree")`, ein Sidebar-Button, `selectRoom()`. Kein Eingriff in Room-/Summon-Logik, keine neue Server-Route, kein neues Datenmodell — die Daten liegen schon im Snapshot.
- **死 „three.js vendoren“** — Grund: Web-Client ist bundlerlos, ESM direkt vom Daemon serviert; `three` (~1.2 MB) ins Repo zu legen wäre ein neuer Vendor-Blob für einen Baum aus ~200 Instanzen. v1 rendert mit **WebGL2 direkt** (eigener Mini-Mat4, ~200 LOC), null neue Dependency, null Build-Schritt.

## 1. Architektur

```
web/src/archtree/
  index.js     view region: mount/unmount, HUD, Klick→selectRoom
  model.js     Snapshot.rooms → ArchtreeModel (Knoten, Kanten, Polarität, Status)
  layout.js    deterministisches radiales/hierarchisches Layout (3D)
  renderer.js  RendererPort-Implementierung "webgl2"
  port.js      RendererPort-Interface + Registry (GWE-Upgrade-Pfad)
  theme.js     Farb-/Aura-Parameter (alle konfigurierbar, keine Magie im Code)
```

### RendererPort (die saubere Schnittstelle — kein Fallback-Pfusch)

```js
/** @typedef {{ mount(canvas, opts): void, update(model, t): void,
 *              pick(x, y): string|null, dispose(): void }} RendererPort */
```

Zwei Implementierungen, gleiche Optik-Sprache, gleicher Vertrag:
- `webgl2` (v1, in-repo, dependency-frei) — **Default**.
- `gwe` (v2, separat) — spricht denselben Port, sendet das `ArchtreeModel` an einen GWE-Web-Client (Vite-Build) in eigenem Kontext und mappt Picks zurück. Wird per Parameter gewählt, nicht per Try/Catch-Degradation: `settings.archtree.renderer` (default `"webgl2"`), `settings.archtree.gweUrl` (default leer → `gwe` meldet `unavailable` **laut**, es wird nie still auf webgl2 zurückgefallen).

**Keine Hardcodes**: alle Zahlen (Ast-Winkel, Aura-Stärke, Verwelk-Dauer, Kamera-FOV, Farben, Polling/Idle-FPS) leben in `theme.js` / `params.js` als benannte Defaults, überschreibbar via Settings-Objekt.

## 2. Datenmodell

```js
ArchtreeNode = {
  id,                 // roomId
  parentId,           // parentRoomId | null
  agent,              // aus room.title/path abgeleitetes Agent-Label
  depth,              // 0 = Wurzel
  status,             // "active" | "done" | "dead" | "idle"
  lastActivity, favorite, incognito, index, siblings, descendants
}
```

**Polarität ist KEIN Modellfeld** (Korrektur gegenüber dem ersten Entwurf, 定 im Implementierungs-Atom): jeder Knoten existiert in *beiden* Hälften. Der Baum wird zweimal gezeichnet — 陽 mit `uYScale = +1`/`LIGHT_THEME`, 陰 mit `uYScale = -params.shadowMirror`/`SHADOW_THEME`. Polarität lebt damit ausschließlich im Renderer (Geometrie-Spiegelung + invertierte Materialsprache, `theme.js:statusColor/statusGlow`), nicht in `model.js`. Ein `polarity`-Feld pro Knoten wäre eine Lüge, weil kein Knoten nur einer Hälfte gehört. 死 „polarity im Modell" — Grund: doppelte Wahrheit ohne Nutzen; die Spiegelung ist eine Darstellung, keine Dateneigenschaft.

Status-Ableitung (rein aus vorhandenen Feldern, kein neues Server-Feld in v1):
- `running: true` → **active** (grün, pulsierendes Blattleuchten)
- `!running && lastActivity` innerhalb `params.freshMs` (default 15 min) → **done** (gold)
- `!running && lastActivity` älter als `params.witherMs` (default 6 h) → **dead** (verdorrt, rot/grau)
- sonst → **idle** (matt)

> Offener Punkt (dokumentiert, nicht geraten): ein echtes `failed`-Bit existiert im `RoomSummary` nicht. Ehrliche v1-Heuristik oben; v1.1-Pfad = `RoomSummary.lastOutcome?: "ok"|"failed"` aus dem Summon-Delivery-Pfad ergänzen (Server-Änderung, eigener Atom).

### Polarität — 陽/陰
Der Baum wird **gespiegelt**: derselbe Graph, zwei Hälften.
- 陽 (oben, +Y): Lichtkrone. Jeder Knoten.
- 陰 (unten, −Y): Schattenwurzel — exakt gespiegelte Geometrie (Ashvattha, umgekehrter Baum), aber invertierte Materialsprache. Der Schatten ist **nicht** eine zweite Datenmenge, sondern dieselbe Wahrheit von unten gesehen: tote/gescheiterte Lanes sind **oben blass und unten grell** — der Schattenbaum ist dort am lebendigsten, wo der Lichtbaum stirbt.

## 3. Visuelle Sprache

**Lichtbaum — Erdtree/Yggdrasil/Alchemie**
- Stamm: kannelierte, leicht gedrehte Säule; goldenes Emissive-Gradient von der Wurzel aufwärts.
- Äste: rekursive Verzweigung entlang der Room-Hierarchie; Astdicke ∝ Anzahl Nachfahren.
- Blätter: pro Knoten ein Cluster leuchtender Partikel; **aktive** Lanes stoßen langsam aufsteigende goldene Funken aus (Erdtree-Aura), Frequenz ∝ Aktivität.
- Aura: radialer additiver Halo hinter dem Baum, warmes Gold (`#ffcf6b`), plus horizontale Godray-Streifen.
- Alchemie-Layer: hinter dem Baum eine dünne, langsam rotierende Sephiroth-/Kreis-Gravur (Linien-Shader, kein Bild-Asset).
- Nordic: Runensteinring um die Wurzel, gemeißelte Kanten, kalter Steingrauton als Kontrast zum Gold.

**Schattenbaum — Scorched Erdtree ∩ Bloodborne**
- Dieselbe Silhouette, verkohlt: Materialfarbe von Gold nach Ascheschwarz, Emissive nach mattem Blutrot (`#8c1f1f`).
- Statt Blättern: bleiche, tote Zweigfinger (Hemwick), knotige Auswüchse an gestorbenen Knoten.
- Statt Funken: langsam **fallende** Asche + gelegentliche Krähensilhouetten (2D-Impostoren) an Forbidden-Woods-Knoten.
- Nebel: bodennaher, blassgrüner Volumendunst (Fake-Volume: gestaffelte Quads), Bloodborne-Mondlicht kalt und hoch.
- Verwelken ist eine **Animation**, kein Zustandswechsel: stirbt eine Lane, kriecht über `params.witherAnimMs` (default 2500 ms) eine Schwärzung vom Blatt zum Ast, das Blattcluster löst sich in Asche auf, der Schattenzwilling **flammt kurz auf**.

**Kamera / Interaktion**
- Orbit (Drag), Zoom (Wheel), Fokus auf Knoten (Klick zentriert), Doppelklick/Enter → `selectRoom()` → Room öffnet sich im Tab, dort steuerbar (`gaia resume`-Äquivalent = normale Room-Eingabe).
- Hover: HUD-Karte mit Agent, Status, letzte Aktivität, Tiefe, Kinderzahl.
- Tastatur: `Esc` schließt die Ansicht, Pfeiltasten wandern Geschwister/Eltern.

### 3.x Ist-Stand v1 (真, am Browser-Proof gemessen — `screenshots/archtree-*.png`)
Ehrliche Trennung zwischen dem, was der webgl2-Port heute liefert, und dem, was §3 als Zielbild beschreibt:

| §3-Element | Ist | Beleg / Grund |
|---|---|---|
| 陽/陰-Spiegelung, Gold vs. Blutrot | **geliefert** | overview.png: Krone gold/grün, gespiegelte Wurzelhälfte rot/asche |
| Aura-Halo + Hintergrundgradient | **geliefert** | Aura-Fullscreen-Pass (`renderer.js` aura-Programm) |
| Statusfarben aktiv/fertig/verwelkt + Wither-Crawl | **geliefert** (Crawl UNVERIFIED: kein Zeitraffer-Shot) | `params.witherAnimMs`, `witherResidualGlow` |
| Klick → `selectRoom()` | **geliefert, bewiesen** | node-click.png zeigt die konkrete `(workspaceId, roomId)` des angeklickten Knotens |
| Blattcluster als sichtbare Partikelwolken | **geliefert** (Optik-Atom 2, lane `archtree-optics`) | `params.leafClusterCount/Radius/Rise/SizeJitter/Sway*`; belegt in `screenshots/after/archtree-overview.png` (Krone, Zoom B1) |
| Aufsteigende Funken / fallende Asche | **geliefert** — Motes für JEDEN Status, Rate ∝ Status (`moteRateActive/Done/Dead/Idle`), Richtung aus `theme.moteRise` | ebd.; Asche-Fall im 陰-Half UNVERIFIED (kein Zeitraffer-Shot, nur Standbild) |
| Ast-Shading | **geliefert** — zwei getrennte Ursachen behoben | (a) flach schattierte Billboards → Zylinder-Normale im VS + wrapped Lambert + Rim (`branchAmbient/Diffuse/RimStrength/RimPower/branchLight*`); (b) **Bowtie**: beide Quad-Enden leiteten die Seitenrichtung aus umgekehrten Achsen ab → Quad klappte um; `aFlip` erzwingt eine Achsenrichtung. Zusätzlich `branchGlowFloor`, damit Status-Glow Holz nie auf Schwarz multipliziert. Vorher/Nachher: `screenshots/before/` vs. `screenshots/after/` |
| Sephiroth-Gravur, Runenring, Krähen, Bodennebel | **nicht implementiert** | bleibt offen (v1.1); Aura/Godrays existieren bereits und sind jetzt vollständig parametrisiert (`auraHalo*`, `auraRay*`) |
| Magic Numbers (Kali-Befund) | **geerntet** | `layout.js` (FNV/Slot/Radius), `renderer.js` (near/far, Pick-Radius, NDC-Remap, Clear-Farbe, Aura-Shader), `theme.js` (`LIGHT_STATUS_GLOW`/`SHADOW_STATUS_GLOW`) |
| Rest-Dunkelheit am Spiegelpunkt | **offen, bewusst** | der 陰-Stamm bleibt nahe der Spiegelachse sehr dunkel (Asche-Bark × `SHADOW_THEME.glow`); liest als Material, nicht mehr als Facettenbruch — Feintuning ist ein eigener Atom |

死 „Optik als erledigt melden" — Grund: an den Screenshots gemessen widerlegt.

## 4. Live-Updates
Kein Polling-Erfinden: das Modul hängt sich an denselben Snapshot-/SSE-Pfad wie die Sidebar (`markDirty("archtree")` bei Snapshot- und Room-Events). Der Renderer läuft rAF-getrieben nur solange die Ansicht sichtbar ist (`dispose()` beim Schließen → kein WebGL-Kontext-Leak, kein Hintergrund-rAF). Idle ohne aktive Lane → `params.idleFps` (default 20) statt volle rAF-Rate.

## 5. Einstiegspunkt
Sidebar-Titelzeile „rooms“ bekommt neben ★ und + ein 🌳-Icon (`title: "archtree"`). Klick öffnet die Vollflächen-Ansicht über dem Transcript (eigene Region, kein Modal-Overlay im Composer-Pfad).

## 6. Abnahme (v1)
1. 🌳 in der Sidebar öffnet die 3D-Ansicht; Baumstruktur entspricht 1:1 der Sidebar-Hierarchie.
2. Laufende Lane grün+funkelnd, frisch fertige gold, alte verdorrt; Statuswechsel sichtbar ohne Reload.
3. Klick auf Knoten → Room ist geöffnet und beschreibbar.
4. 陽/陰-Spiegelung sichtbar, Schattenbaum eigenständig gestaltet.
5. `bun run check` grün; `bun test test/archtree-model.test.ts` grün (Modell/Layout sind reine Funktionen und werden headless getestet).
6. Kein neuer npm-Dependency, kein Core-Verhalten geändert.

## 7. Offene Punkte
- `failed`-Status braucht ein echtes Server-Bit (s. §2).
- GWE-Renderer (`port: "gwe"`) ist Design + Interface, nicht v1-Implementierung.
- Sehr breite Bäume (>500 Rooms) brauchen Instancing-Batching / Level-of-Detail.
