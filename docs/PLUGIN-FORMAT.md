# PLUGIN-FORMAT — pi package is THE format (Pascal 09-05 ruling)

Adversary ruling: docs/PLUGIN-ADVERSARY-0905.md axis 7 (two-format debt) +
axis 1 (pi compatibility). Ref: ~/projects/gaia-plugins doctrine — "No
parallel gaia-only plugin format".

## Verdict
- pi package (package.json `pi` field → extensions/skills/prompts/themes,
  loaded by pi's own DefaultResourceLoader/DefaultPackageManager) = THE
  plugin format. Not co-equal with gaia's own `plugin.json` manifest format.
- gaia manifest format (`src/services/plugins/manifest.ts`,
  `engine: gaia-daemon@...`) = DEPRECATED for 3 of its 4 contribution kinds.

## Per-kind status (contracts.ts is the source of truth, this table mirrors it)
| kind | status | pi replacement | notes |
|---|---|---|---|
| command | @deprecated | `pi.registerCommand` | executes in LANE sandbox, not daemon; `gaia plugin migrate` generates the pi-extension.mjs wrapper (pi-adapter.ts) |
| tool | @deprecated | `pi.registerTool` | same as above; generic passthrough TypeBox schema (no real tool-contribution plugin exists yet to verify against) |
| provider | @deprecated | `pi.registerProvider`/`registerNativeProvider` | narrower concept (LLM MODEL providers only) than gaia's generic provider port — not a 1:1 map, migrate.ts still moves it, flagged in migrate output |
| channel-bridge | first-class, NOT deprecated | none — pi's ExtensionAPI has no channel-bridge concept | stays daemon-side indefinitely; the one kind `gaia plugin migrate` reports "stayed daemon-side" |

## Where this is enforced
- `src/services/plugins/contracts.ts` — `@deprecated` JSDoc on
  `PluginCommandContribution`/`PluginToolContribution`/`PluginProviderContribution`;
  `PluginChannelBridgeContribution` explicitly marked first-class.
- `src/services/plugins/loader.ts` — `warnDeprecatedContributionKinds()`,
  one-line `console.warn` per plugin load declaring any of the 3 deprecated
  kinds. Never fatal — old manifest plugins keep working through the
  deprecation window.
- `gaia plugin migrate <dir>` (`src/services/plugins/cli.ts` +
  `src/services/plugins/migrate.ts`) — output states, per plugin, which
  contributions moved to pi (`movedToPi`) vs stayed daemon-side
  (`stayedDaemon`).

## Deprecation timeline
Remove the `command`/`tool`/`provider` contribution kinds from
`src/services/plugins/{contracts,manifest,registry}.ts` (validator +
types + invoke path) ONLY after BOTH:
1. All 11 known manifest plugins migrated (bundled 4: defaults, fugu, rpg,
   rpg-engine; user-level 7: love, whip, ultrawhip, ultralove, rpg,
   rpg-engine, runner — 2 of the 7 have no valid plugin.json today and are
   not migratable as-is, see LANE C ghoul report for per-dir status).
2. Pascal `/rebuild` + a LIVE proof run through the real daemon (not a
   worker smoke test) confirms every migrated plugin's pi-side commands
   still work end-to-end in a real lane.
`channel-bridge` is exempt from this timeline — it has no pi replacement and
is never removed.
