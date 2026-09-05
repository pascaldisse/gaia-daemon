---
name: gaia-plugin
description: Extend GAIA without touching daemon source — a gaia plugin is a pi package (commands, tools, providers). Surfaces reachable from a room, minimal extension, CLI, publish flow, and the one gaia-native surface pi has no equivalent for (channel bridges).
---
# Gaia plugin
## §0 · rule (Pascal 09-05 doctrine, docs/PLUGIN-FORMAT.md)
- Gaia plugin = **pi package** (`package.json` `pi` field → extensions/skills/prompts/themes, loaded by pi's own `DefaultResourceLoader`/`DefaultPackageManager`). One format. Never edit/import gaia daemon `src/`.
- OLD `~/.gaia/plugins/*.mjs` gaia-native manifest format (`engine: gaia-daemon`, `plugin.json`) is **DEPRECATED** for 3 of its 4 contribution kinds (commands/tools/providers) — see §5. Do not build new plugins against it.
- Missing pi ExtensionAPI hook → file it against pi itself, or use §5's one surviving gaia-native path (channel-bridge). Never a local daemon fork/workaround.
## §1 · surfaces — what reaches a GAIA room
Source of truth: `src/harness/pi/ui-context.ts` (bridge table), `src/harness/pi/events.ts` (`forwardPiEvent`), `src/harness/pi/runtime.ts` (command dispatch). Current as of main `4da2981` (Lane E landed — commands + full event passthrough are LIVE, closing the gaps `docs/PLUGIN-ADVERSARY-0905.md` found on 09-05).

| `ExtensionAPI` method | Room behaviour |
| --- | --- |
| `registerCommand(name, {handler})` | Real `/name` dispatch. `services/room/queue.ts` routes any unclaimed `/word` to the active pi agent as a `nativeCommand` turn; `runtime.ts`'s `resolveExtCommand` checks `extensionRunner.getCommand(name)` — registered → calls `command.handler(args, runner.createCommandContext())` directly (SDK's own invocation, never re-implemented gaia-side). Unregistered → falls through to a skill remap or raw prompt text. |
| `registerTool(...)` | Agent tool, visible on `session.getActiveToolNames()` the instant the extension loads. Flows through the SDK's own agent loop; zero gaia-side wiring needed. |
| `registerShortcut(key, {handler})` | Web hotkey. `bindPiShortcuts` mirrors every `runner.getShortcuts()` entry into a `ui.shortcut` AgentEvent; a client-fired `commandId` dispatches to the extension's real handler via `AgentRuntime.uiShortcutFire`. |
| `registerProvider` / `registerNativeProvider` | Model provider + login card. Flushed into the harness's model registry right after `loader.reload()`, before model resolution. OAuth/device-code login rides `ModelRuntime.login()` wrapped by `wrapAuthInteraction`, triggered by `AgentInput.uiLogin` (`POST /api/workspaces/:ws/rooms/:id/login`) → same `auth.request`/`ui.reply` channel as any other dialog; web: Settings ▸ Accounts "Login via room", gated on `GET /api/accounts`'s `harnesses[].uiLogin`. |
| `ctx.ui.select/confirm/input/editor` | Prompt banner (`ui.prompt` AgentEvent), 10 min timeout (`DEFAULT_UI_TIMEOUT_MS`) → falls back to pi's own no-op default (false/undefined) rather than hang the turn. A client answers via `AgentRuntime.uiReply`. |
| `ctx.ui.setWidget` / `notify` / `setStatus` | Transcript widget row (`ui.widget` AgentEvent). `notify`/`setStatus` route through the SAME widget event (no separate toast kind) — each `notify` call gets a fresh id so repeats stack as distinct rows. |
| `registerMessageRenderer` / `registerEntryRenderer`, `setFooter/setHeader/setTitle/custom`, editor manipulation, `theme`/`getAllThemes`/`setTheme` | **NO-OP.** TUI-only Component factories / raw terminal chrome — not serializable over a room transport. Matches pi's own headless (`noOpUIContext`) defaults exactly; extension code doesn't crash, the dialog/widget just never renders. |
| `pi.on(eventName, handler)` (all ~25 `ExtensionEvent` kinds) | **All forwarded.** 9 kinds get a typed `AgentEvent` (text/thinking deltas, tool start/update/end, skill-invocation, context-usage, message error). Every other kind (`session_start`, `turn_start`, `agent_end`, custom `pi.sendMessage()`, …) surfaces as a generic `harness.event {kind, payload}` (depth/size-capped, 32KB default) instead of being silently dropped — `forwardPiEvent` has no default/no-op branch left uncovered. |
| `registerFlag` | Inert. No CLI invocation surface inside a lane; never queried, never crashes. |

UNVERIFIED-live: this table is proven at the SDK level (`test/pi-runtime.test.ts`, `test/skills-gaia-plugin.test.ts` — real `DefaultResourceLoader`+`createAgentSession`, in-process, no LLM call) — not yet re-confirmed through a live `gaia summon` after Pascal's next `/rebuild`. Say so if you cite "works in a room" beyond that.
## §2 · minimal extension — copy-paste
Full working copy: `skills/gaia-plugin/example/` (`package.json` + `extension.mjs`) — loaded and asserted by `test/skills-gaia-plugin.test.ts`.

`package.json`:
```json
{
  "name": "gaia-plugin-example",
  "version": "1.0.0",
  "description": "Minimal gaia plugin (pi package): one command, one tool, one ui.confirm.",
  "keywords": ["pi-package"],
  "type": "module",
  "private": true,
  "dependencies": { "typebox": "*" },
  "pi": { "extensions": ["./extension.mjs"] }
}
```

`extension.mjs`:
```js
import { Type } from "typebox";

export default function gaiaExampleExtension(pi) {
  pi.registerCommand("gaia-example", {
    description: "gaia-plugin example: confirm, then reply",
    handler: async (args, ctx) => {
      const ok = await ctx.ui.confirm("gaia-example", `Run with args "${args}"?`);
      ctx.ui.setWidget("gaia-example-status", [ok ? "confirmed" : "declined"]);
    },
  });

  pi.registerTool({
    name: "gaia_example_echo",
    label: "Gaia Example Echo",
    description: "Echoes the given text back, prefixed. Marker tool proving this extension loaded.",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: `gaia-example: ${params.text}` }],
      details: {},
    }),
  });

  return { dispose() {} };
}
```
### Local dev loop
- Drop the package dir under `<workspace>/.pi/extensions/` (project-local, no install step), OR `gaia plugin install ./path/to/dir --local` (writes it into pi's own project-scope settings via `DefaultPackageManager`).
- Which lanes pick it up: only harnesses whose `HarnessSpec.extensions.discover === true` — read uniformly, no harness-id branch (`discoveringLaneLabels()` in `src/services/plugins/cli.ts` prints the live list after `install`). Today: pi.
- **Reload semantics** — precise, don't guess: a NEW pi session (new room, or a reset one) picks up the extension on its next turn automatically. An ALREADY-RUNNING pi session for a room does not re-scan the filesystem mid-session — trigger `ctx.reload()` from inside another command, or start a fresh session, to pick up a just-added/edited extension file. This is independent of Pascal's own `/rebuild` (that rebuilds the gaia-daemon binary itself from `src/`, never needed for a plugin change — AGENTS.md "dev mode DELETED").
- UNVERIFIED-live: the reload path above is read from pi's own `ExtensionCommandContext.reload()` type signature (node_modules d.ts) and `DefaultResourceLoader` discovery semantics — not yet exercised through a live `gaia summon` editing a file mid-session. Confirm before promising a coworker hot-reload.
## §3 · `gaia plugin` CLI
Real `gaia plugin` (no subcommand) output:
```
Usage:
  gaia plugin search <query>                 search the GAIA Plugin Store registry
  gaia plugin info <id|source>                show registry details for one entry
  gaia plugin install <id|source> [--local]   install a pi package (registry id, or a raw npm:/git:/path source)
  gaia plugin remove <id|source> [--local]    remove an installed pi package
  gaia plugin update [id|source]              update one (or, if omitted, every) installed pi package
  gaia plugin list                             list installed pi packages + locally-registered extension paths
  gaia plugin migrate <dir>                    turn an existing gaia plugin.json package at <dir> into a pi package in place (idempotent)

Env: GAIA_PLUGIN_REGISTRY overrides the registry URL (default https://paloptic.com/gaia-plugins/registry/index.json)
```
- `search`/`info` hit the GAIA Plugin Store registry (`registry-client.ts`, 24h local cache); `install`/`remove`/`update`/`list` delegate **in-process** to pi's own `DefaultPackageManager` — zero shelling out to a `pi` binary.
- `install <id>`: resolves a registry id to its `source` (must be `npm:`/`git:` per store doctrine) first, else passes the given string straight through to pi's own source parser (so a raw `npm:`/`git:`/local-path source works even with no registry entry). `--local` = project scope vs user scope.
- `gaia plugin migrate <dir>` → §5.
- `gaia plugin --help` currently prints the top-level `gaia --help` text instead of plugin usage — the global `--help`/`-h` short-circuit in `src/cli.ts` fires before subcommand dispatch. Known quirk; use `gaia plugin` (no args) to see the usage block above.
## §4 · publish to the store
- Package (§2 shape, `keywords` MUST include `"pi-package"`, `pi.{extensions,skills,prompts,themes}` non-empty) → push to a git repo (npm publish also fine — `source: "npm:..."` is what the registry stores, not a copy of the code).
- Two publish paths, both gated by `~/projects/gaia-plugins/scripts/validate.ts`:
  1. **PR to `registry/index.json`** — manual entry, must pass `bun test` (`validateRegistry` runs over the real file every run). Required per store's schema:
     ```json
     {"id":"pi-goal","name":"Pi Goal","description":"...","source":"npm:pi-goal","version":"0.1.7","tags":["autonomy","goals"],"author":"you","homepage":"https://...","verified":false,"added":"YYYY-MM-DD"}
     ```
     `source` MUST start with `npm:` or `git:` — no other form accepted (doctrine gate). `verified:true` means someone confirmed it actually installs on a real pi, not just "exists on npm" — leave `false` until you've done that.
  2. **`cd ~/projects/gaia-plugins && bun run publish -- npm:<pkg>[@version]`** — fetches `package.json` via `npm view` (no install), runs `validatePiPackageJson`, appends with `verified:false`. `git:` sources are NOT automated (no generic git-hosted package.json fetch without cloning) — use path 1.
- Deploy (who runs it — not you unless asked): `~/projects/gaia-plugins/deploy/rollout.sh` — build → rsync `site/dist/` → Caddy config splice → `caddy validate` → reload → external gate (`curl` 200 on the registry JSON + site root). Any failing step restores from `/root/gaia-plugins-backups/<stamp>` and reloads Caddy; the box is never left mid-deploy.
- Limits: `source` = one string only, no subpath into a monorepo package — publish the package's own root.
## §5 · channel-bridge — the ONLY remaining gaia-manifest kind
- pi's `ExtensionAPI` has **no channel/transport concept at all** — `registerCommand`/`registerTool`/`registerProvider` all map onto a real pi surface; a channel bridge (Telegram/Discord/…) does not. AGENTS.md: "Channel bridges = plugins, never core."
- Contract (`src/services/plugins/contracts.ts` `PluginChannelBridgeContribution`, explicitly marked first-class, NOT `@deprecated`):
  ```ts
  export interface PluginChannelBridgeContribution {
    readonly name: string;
    handle(context: CapabilityContext, request: { direction: "incoming" | "outgoing"; payload: JsonValue }): { handled: boolean; payload?: JsonValue } | Promise<...>;
  }
  ```
  Declared in `plugin.json`'s `contributes.channels`, invoked through `invokePluginChannelBridge` (`contracts.ts`) — same `CapabilityBroker.authorize()` gate as any other gaia-native contribution, BEFORE `handle()` runs.
- `command`/`tool`/`provider` gaia-manifest kinds are `@deprecated` JSDoc-tagged in `contracts.ts` (still load — `loader.ts`'s `warnDeprecatedContributionKinds()` logs one warning per plugin, never fatal) — do not add new plugins using them. `gaia plugin migrate <dir>` auto-generates the pi-side `pi-extension.mjs` replacement for commands/tools (`src/services/plugins/pi-adapter.ts`); channel-bridge contributions are reported "stayed daemon-side" by the same migrate output and are left exactly as-is.
- Removal timeline (`docs/PLUGIN-FORMAT.md`): the 3 deprecated kinds are deleted from `contracts.ts`/`manifest.ts`/`registry.ts` only after (1) all known manifest plugins migrated and (2) a Pascal `/rebuild` + live-room proof of every migrated plugin's pi-side commands. `channel-bridge` is exempt — never removed.
## §6 · testing law
- **SDK-level, not a smoke script.** Load the real extension through pi's own `DefaultResourceLoader` + `createAgentSession`, in-process, no mocks of pi, no LLM call needed for command/tool dispatch assertions. Copy-paste template (mirrors `test/pi-runtime.test.ts`, proven — see `test/skills-gaia-plugin.test.ts`):
  ```ts
  import assert from "node:assert/strict";
  import { join } from "node:path";
  import test from "node:test";
  import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
  import { createTempDir } from "./helpers/temp.js";

  const EXT = join(process.cwd(), "path", "to", "your-extension.mjs");

  test("my extension: tool is discovered", async () => {
    const temp = await createTempDir();
    try {
      const loader = new DefaultResourceLoader({
        cwd: temp.path,
        agentDir: join(temp.path, "agent-dir"),
        additionalExtensionPaths: [EXT],
        noExtensions: false,
      });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: temp.path, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      try {
        assert.ok(session.getActiveToolNames().includes("your_tool_name"));
      } finally {
        session.dispose();
      }
    } finally {
      await temp.cleanup();
    }
  });
  ```
  For a command: `session.extensionRunner.getCommand("name")` then `await command.handler(argsString, runner.createCommandContext())` — dispatches the REAL handler, same call `runtime.ts`'s `resolveExtCommand` makes in a live room.
- BUN ONLY: `bun test test/<your-test>.test.ts` — touched file directly, never the full glob (state leaks across `node:test`-compat files, AGENTS.md).
- Live room proof (the actual claim a coworker needs): after Pascal's next `/rebuild`, `gaia plugin install ./your-dir --local` in a real workspace → send `/your-command` in a real room via `gaia summon` or the web UI → paste the transcript. SDK-level green ≠ "works in a room" — say UNVERIFIED until that proof exists.
## §7 · before sending
```text
[ ] no gaia-daemon src/ import; no core edit
[ ] package.json: keywords includes "pi-package", pi.{extensions|skills|prompts|themes} non-empty
[ ] command/tool names don't collide with pi builtins or another loaded extension
[ ] bun test <your extension's test> green, real DefaultResourceLoader/createAgentSession
[ ] SDK-level proof stated as such; live-room proof (post-/rebuild) marked UNVERIFIED until actually run
[ ] channel-bridge need? → §5 gaia-native contract, not registerCommand/Tool
[ ] publish: source is npm: or git:, no subpath; validate.ts passes before PR/bun run publish
```
## §8 · pointers
```text
docs/PLUGIN-FORMAT.md                        doctrine ruling + per-kind status table + deprecation timeline
docs/PLUGIN-ADVERSARY-0905.md                judge-not-builder review this doctrine responds to (§1/§4 gaps, now closed by Lane E on main)
src/harness/pi/ui-context.ts                 ExtensionUIContext → ui-bridge bind/no-op table (§1 source)
src/harness/pi/ui-bridge.ts                  AgentEvent ui.* vocabulary, pi-agnostic + independently testable
src/harness/pi/events.ts                     forwardPiEvent — typed cases + harness.event catch-all
src/harness/pi/runtime.ts                    resolveExtCommand / command dispatch / uiLogin turn / bindPi* call sites
src/services/plugins/contracts.ts            gaia-native contribution ports; @deprecated tags; channel-bridge first-class
src/services/plugins/pi-adapter.ts           gaia-format → pi-extension.mjs code generator (migrate's output)
src/services/plugins/migrate.ts              gaia plugin migrate <dir> implementation
src/services/plugins/cli.ts                  gaia plugin CLI (search/info/install/remove/update/list/migrate)
src/services/plugins/registry-client.ts      store registry fetch + 24h cache, GAIA_PLUGIN_REGISTRY
plugins/fugu/{package.json,pi-extension.mjs} exemplar migrated package (real, in-repo)
test/fixtures/pi-ext/{register-command,register-tool,ui-calls}.ts  exemplar extensions used by pi-runtime.test.ts
test/pi-runtime.test.ts                      full SDK-level test suite this skill's §6 template mirrors
test/plugin-cli.test.ts                      CLI-level test pattern (search/info/install/migrate)
skills/gaia-plugin/example/                  this skill's own §2 extension, loaded by test/skills-gaia-plugin.test.ts
~/projects/gaia-plugins                      store repo: registry schema, validate.ts, publish.ts, deploy/rollout.sh
https://paloptic.com/gaia-plugins/           live store site
node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts   ExtensionAPI/ExtensionContext ground truth (pi docs/extensions.md path does not exist on this machine — UNVERIFIED path, use the .d.ts instead)
```
