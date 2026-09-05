# Plugin refactor — adversary review · 0905

Judge, not builder. Independent derivation, code read, no code changes. All
claims file:line or `git`/`bun` output; unknown marked UNVERIFIED.

## §method

- v1 main HEAD read live: `src/services/plugins/{contracts,loader,manifest,registry}.ts`.
- `git diff main..room/chat-mto9n58s-bjr1/pi-ext` — 1 commit at scope-read
  time (`5d5b1eb`), 2 by review end (`9c6f95f`, landed mid-review — Pascal
  rejected a process-global env mutation, replaced w/ scoped guard; see §1).
- `room/chat-mto9n58s-bjr1/ext-ui` — 0 commits ahead of main when the branch
  was inspected (`git log main..ext-ui` empty, `git merge-base` = main HEAD);
  the entire Lane-B UI-bridge surface existed ONLY as uncommitted worktree
  diff (`.gaia/worktrees/chat-mto9n58s-bjr1-b`) until it landed as `5cb9acd`
  **during this review** (see §5, top-fix 5).
- `bun test test/pi-runtime.test.ts` (worktree -a, HEAD `9c6f95f`): 50 pass/0
  fail. `bun test test/ext-ui-events.test.ts test/runner-host.test.ts`
  (worktree -b, HEAD `5cb9acd`): 28 pass/0 fail. `bun run check` exit 0 on
  both worktrees (knip unused-export noise only, no type errors).
- pi SDK surface read from `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{types,runner,loader}.d.ts`
  (repo-local install; `/Applications/gaia-daemon.app/Contents/MacOS/docs/{extensions,packages}.md`
  does NOT exist on this machine — UNVERIFIED, path stale or app not installed here).
- deepseek: `~/projects/deepseek-harness` (`docs/PLUGIN-RECON.md`'s named
  clone) — spot-checked `packages/extensions/cordis-host-runner/src/{lifecycle,sandbox}.ts`
  directly against the recon doc's `§deepseek` isolation claim (finding: recon
  is accurate for CORE Cordis/profile plugins, incomplete for this one
  extension package — see §2).
- gaia v2: `~/projects/gaia-daemon-v2/src/services/plugins/{backend,index,loader,manifest,sandbox,steer,types}.ts`.
- store: `~/projects/gaia-plugins` (`docs/README.md`, `registry/index.json`).

## §verdict table

| # | axis | verdict | one-line evidence |
|---|---|---|---|
| 1 | pi compatibility | **CONFLICT** | registerCommand/Shortcut/MessageRenderer/EntryRenderer unreachable from a gaia room; 9 of ~25 `ExtensionEvent` kinds forwarded, rest silently dropped |
| 2 | deepseek best-of | **GAP** | v1 registry keeps generation/dispose/rollback (steal-list honored); ZERO isolation adopted — not even deepseek's own vm+capability-trap pattern (a real, available precedent) |
| 3 | v2 best-of | **GAP** | v1 absorbed nothing from v2 `sandbox.ts` (real subprocess isolation) or `backend.ts`/`steer.ts` (pluggable turn backend, generic steer seam); `steer.ts`'s `persistBeforeSteer` pattern is a clean absorb candidate v1 lacks |
| 4 | extensibility ceiling | **GAP** | auth/composer/hotkeys/widgets now HAVE a wire (ext-ui, uncommitted-turned-committed mid-review) but zero producer; transcript custom renderers and channel-bridges have NO pi-native path at all (pi has no channel concept) |
| 5 | RULE #0 audit | **PASS** | both branches: 100% data-on-spec (`HarnessSpec.extensions`, `capabilities.supportsUi`), zero `harness === "pi"` branch in shared code; only the SDK-private-field reach-in in `9c6f95f` is a (justified, documented) fragility, not a RULE #0 violation |
| 6 | design-node drift | **CONFLICT** | manifest-plugin contribution code runs in-process in the daemon with **zero OS/process sandbox**, independent of any room/agent `trust` bit — a global, boot-time authority path AGENTS.md's "Trust is data" protocol never reaches; `DESIGN-ARCHTREE.md:14` also describes a plugin mechanism that no longer exists in code |
| 7 | two-format debt | **CONFLICT** | `~/projects/gaia-plugins/docs/README.md` doctrine ("No parallel gaia-only plugin format… NOT pi packages… intentionally excluded") already rejects exactly the format `src/services/plugins/manifest.ts` is actively building (`engine` field, `~/.gaia/plugins` discovery) |

## §1 pi compatibility — CONFLICT

What DOES reach a gaia room after `pi-ext` (`9c6f95f`):

- **`registerTool`** — real. Confirmed by `test/fixtures/pi-ext/register-tool.ts`
  + `test/pi-runtime.test.ts:"pi extension fixture … registers a tool visible
  on the session's active tool list when discovered"` (SDK-level, in-process,
  green). Tool calls flow through the SDK's own agent loop regardless of UI —
  no gaia-side wiring needed for this one surface.
- **`registerProvider`/`registerNativeProvider`** — real. `runtime.ts` flushes
  `extensionRuntime.pendingProviderRegistrations`/`pendingNativeProviderRegistrations`
  into `this.modelRegistry` right after `loader.reload()`, BEFORE
  `resolveModel()` runs (`src/harness/pi/runtime.ts` ~415-432 per `5d5b1eb`'s
  own commit message; mirrors pi's `AgentSession.bindCore()` ordering).
- **`registerFlag`** — inert, harmless. No CLI invocation surface in a lane;
  never queried, never crashes.
- **`ctx.ui.*` (select/confirm/input/notify/setWidget/…)** — pi's own
  `noOpUIContext` (SDK-internal, `dist/core/extensions/runner.js`) absorbs
  every call as a silent no-op today — confirmed by `pi.ts`'s own doc comment
  in `5d5b1eb`'s diff ("LANE-B: ui bridge — headless safety is ALREADY
  covered by pi's own SDK … nothing to wrap at our layer"). Non-crashing, but
  every dialog silently vanishes — an extension author gets no signal.

What does **NOT** reach a gaia room (dead surfaces), each with the exact
mechanism killing it:

- **`registerCommand`** — UNREACHABLE, not just unwired. `src/services/room/queue.ts:54`
  runs gaia's OWN `parseCommand(text)` (`../commands.js`) on every message
  BEFORE the harness ever sees it. `queue.ts:61` `if (command.type === "unknown")`
  first tries `runPluginCommand` (`queue.ts:29,69` — the GAIA-native manifest
  plugin registry, §7), and only THEN falls through to a fixed
  "native-passthrough" allowlist keyed on `agent.skills` (comment at
  `queue.ts:55-60`: "an unrecognized `/command` becomes a command TURN … when
  that agent has CHECKED that command as a skill"). `src/harness/pi/runtime.ts:112`
  `async *send()` calls `session.prompt(prompt, { source: "interactive" })`
  directly (`runtime.ts:157-163`) — never `session.getCommand(name)` or any
  pi-native command dispatch. A pi package's `pi.registerCommand("foo", …)`
  handler is invoked by NOTHING a gaia room can produce, regardless of
  `pi-ext`. This is the single largest "unmodified pi package… functions in a
  gaia lane" claim gap.
- **`registerShortcut`** — TUI keybinding surface; dead in a headless lane
  with no terminal. `ui-bridge.ts` (ext-ui, `5cb9acd`) DOES define a mirror
  (`registerShortcut`/`fireShortcut`, `src/harness/pi/ui-bridge.ts`
  "registerShortcut mirror") but nothing in `pi.ts`/`runtime.ts` calls
  `createUiBridge` or sets `capabilities.supportsUi` — confirmed by grep: zero
  hits for `createUiBridge`/`supportsUi` outside `spec.ts`/`host.ts`/`ui-bridge.ts`
  itself (`ui-bridge.ts` is imported by NOTHING but its own test). Wire exists,
  producer doesn't — full-stack GAP, not yet a working feature.
- **`registerMessageRenderer` / `registerEntryRenderer`** — TUI `Component`
  factories (ANSI terminal widgets). `src/harness/pi/events.ts:13`
  `forwardPiEvent` is a closed allowlist of exactly 9 conditions
  (`message_start` user-only for skill-block detection, 4×`message_update`
  deltas, 3×`tool_execution_*`, 2×`message_end` branches) — EVERY other
  `ExtensionEvent` from `types.d.ts`'s `ExtensionEvent` union (`session_start`,
  `session_shutdown`, `agent_start`, `agent_end`, `agent_settled`,
  `turn_start`, `turn_end`, `model_select`, `thinking_level_select`,
  `user_bash`, `input`, `before_agent_start`, …) is silently dropped — the
  function has no `else`/default branch, no logging, nothing. A `pi.sendMessage()`
  custom message (which is what `registerMessageRenderer` exists to render)
  never produces an `AgentEvent` at all; it is invisible end-to-end, not just
  unrendered.

Verdict: **CONFLICT** with the doctrine's own framing ("pi package NATIVELY") —
tools + providers work; commands, shortcuts, renderers, and the entire
lifecycle-event surface do not, and two of those four (`registerCommand`,
renderers) are killed by pre-existing gaia routing code `pi-ext` never
touched, not by anything `pi-ext` chose to leave for later.

## §2 deepseek best-of — GAP

`docs/PLUGIN-RECON.md` §steal-list is followed for the parts that shipped:
staged-registry + turn-lease (`src/services/plugins/registry.ts:155-260`
`#stageReload`/`#applyTurnBoundary`, mirrors deepseek Fiber settle-or-dispose
semantics), capability-invocation broker
(`src/services/capabilities/broker.ts:72-108` `CapabilityBroker.authorize`),
typed registration ports (`src/services/plugins/contracts.ts:47-63`
`PluginCommandContribution`/`PluginToolContribution`/`PluginChannelBridgeContribution`/`PluginProviderContribution`),
lifecycle disposer + atomic replacement (`registry.ts` `#dispose`, LIFO order,
per-plugin catch so one disposer's throw never blocks the rest).

What's LOST vs Cordis, confirmed against recon:

- Dependency ordering / `ctx.inject` re-activation — v1 has none; a plugin
  needing another plugin's service has no declared-dependency mechanism, only
  `requiredCaps` (an authorization list, not a wiring graph).
- Partial reload / HMR — v1's `stageReload()` rebuilds the FULL generation
  every time (`registry.ts` `#stageReload` calls `this.#loader(...)` for every
  plugin, reuse only via content-digest match) — coarser than Cordis's
  per-module HMR replace, acceptable trade for a compiled-binary daemon
  (no dev watcher, AGENTS.md "dev mode DELETED") but worth stating explicitly
  rather than silently.
- Typed/reorderable event hooks (`tools/pre-execute`, `session/event`
  waterfalls) — v1 has NONE; the only "hook" is invoke-time capability
  authorization, not a general extension point other plugins can chain.

**Isolation — recon nuance, not just a gap.** `docs/PLUGIN-RECON.md` §deepseek
says "in-process same JS realm … not OS/process isolation" — true for CORE
Cordis / profile-loaded packages, but INCOMPLETE: deepseek ships its own
`packages/extensions/cordis-host-runner/src/sandbox.ts` — a `node:vm` realm
per dynamic plugin, with `NODE_API_REDIRECTS` (`sandbox.ts` lines ~92-110)
that replace `require`/`setTimeout`/`fetch`/etc with throwing traps steering
code toward injected `ctx.fs`/`ctx.web`/`ctx.bash` services — explicitly
documented as "not containment… host-realm helper functions remain an escape
route" (`sandbox.ts` top comment) but strictly stronger than v1's current
posture (§6): v1's manifest plugins get the REAL, unwrapped Node/Bun globals,
no trap layer at all. v1 adopted the cooperative-authorization half of
deepseek's model and skipped the (admittedly narrower, dynamic-package-only)
vm-trap half entirely — worth lifting for `requiredCaps` enforcement instead
of trusting a plugin's own code to only call what it declared.

## §3 v2 best-of — GAP

v2 concepts NOT in v1, each read directly from `~/projects/gaia-daemon-v2/src/services/plugins/`:

- **`sandbox.ts`** — `SandboxProvider.wrap(request: SandboxWrapRequest)` with
  `writable`/`readonly`/`denyRead`/`net: "none"|"full"` — real OS-level
  subprocess wrapping (same shape as gaia's own harness-runner sandbox, just
  aimed at plugin code). v1's manifest plugins have NO equivalent — should
  absorb: wrap plugin contribution invocation in the SAME sandbox machinery
  `RunnerHost` already uses for harness subprocesses (`sandboxPaths` on
  `HarnessSpec`, per `spec.ts`), rather than leaving plugin code as the one
  unwrapped execution path in the daemon (§6).
- **`backend.ts`** — `BackendPlugin.handle(frame: BackendEventFrame)` with a
  typed `turn|abort|steer|restore|compact|fork` frame contract
  (`assertBackendEventFrame`, `dispatchBackendFrame`) — a genuinely pluggable
  TURN BACKEND a manifest plugin could implement. v1's harness registry
  (`src/harness/spec.ts`) is closed: only code in `src/harness/<x>.ts` can add
  a runtime; no manifest plugin can ever supply one. Under pi-first doctrine
  this is LOW priority (a THIRD harness-equivalent is not the doctrine's
  goal) but worth naming as an explicit non-goal rather than a silent gap.
- **`steer.ts`** — `persistBeforeSteer(host, input)`: persist guidance →
  try live steer → append steered marker OR deliver as an ordinary turn. This
  is a clean, harness-agnostic pattern any gaia-native plugin steering a room
  (the manifest system's `PluginCommandResult.steer`, `contracts.ts`) should
  reuse instead of ad hoc steer-or-fallback logic scattered in
  `services/room/queue.ts`. Concrete, low-risk absorb candidate.
- v2's `manifest.ts`/`loader.ts` (strict `plugin.json`, `realpath` + symlink
  containment, generation-keyed reload) are essentially the SAME design v1
  already has (`src/services/plugins/manifest.ts`/`loader.ts` — same
  containment checks, same digest-keyed reuse) — no absorb needed, parallel
  invention, not a gap.

## §4 extensibility ceiling

| surface | 3rd party can extend today? | pi ExtensionAPI surface | gap if none |
|---|---|---|---|
| tools | YES | `registerTool` | — |
| model providers | YES | `registerProvider`/`registerNativeProvider` | — |
| composer widgets/dialogs | NO (wired, unproduced) | `ctx.ui.setWidget/select/confirm/input` → `ui-bridge.ts` → `ui.widget`/`ui.prompt` AgentEvent → `web/src/composer.js` (ext-ui `5cb9acd`) | Lane A never calls `createUiBridge` (§1) |
| hotkeys | NO (wired, unproduced) | `registerShortcut` → `ui.shortcut` → `composer.js` hotkey bind | same as above |
| auth/login flows | NO (wired, unproduced) | `registerProvider(...).oauth.login` → `auth.request` → `web/src/settings.js` login cards | same as above |
| slash commands | **NO — no path at all** | `registerCommand` | gaia's own `parseCommand`/skill-allowlist owns `/word` before the harness ever runs (§1); needs an explicit fallback: unknown gaia command + agent's pi session has a registered command of that name → dispatch to it |
| transcript custom renderers | **NO — no path at all** | `registerMessageRenderer`/`registerEntryRenderer` | pi's `Component` factories are TUI-only objects; no wire can serialize an arbitrary terminal component to a browser. Needs a NEW, DECLARATIVE protocol event (data-only, same principle as the legacy `PluginPanel` — see `DESIGN-ARCHTREE.md:14`'s own "explicitly no iframe/browser surface" rule), not a pi Component bridge |
| room lifecycle hooks (session/turn/agent events) | **NO — silently dropped** | `on("session_start"\|"turn_start"\|"turn_end"\|"agent_end"\|…)` | `forwardPiEvent` allowlist (§1) has no case for any of these; needs new `AgentEvent` kinds or explicit non-support statement |
| channel bridges | gaia-native only (`contracts.ts` `PluginChannelBridgeContribution`) | **none — pi has no channel-bridge concept in `ExtensionAPI`** | doctrine conflict: "gaia plugin = pi extension NATIVELY" cannot cover channel bridges; needs an explicit doctrine carve-out (§7) |
| sandbox policy | correctly NOT extensible | n/a | intentional — a plugin altering its own sandbox would be a privilege-escalation vector; not a gap |
| settings.json / gaia workspace settings | NO | n/a in pi (`registerFlag` is CLI-only, doesn't touch gaia's settings panel) | low priority; no evidence anyone needs it yet |

## §5 RULE #0 audit — PASS

Both branches read cleanly against AGENTS.md RULE #0:

- `pi-ext` (`5d5b1eb`+`9c6f95f`): `spec.ts` adds DATA (`HarnessSpec.extensions:
  {discover, additionalPaths, installMissing}`), `runner.ts` resolves it ONCE
  (`harnessSpecFor(harness).extensions`) and threads uniformly into every
  `create(ctx)` call — comment at `runner.ts` explicit: "Shared code never
  branches on harness id (RULE #0); only pi's spec sets a truthy value
  today." `pi.ts` is the ONLY file that sets the field. No `harness === "pi"`
  string anywhere in `spec.ts`/`runner.ts`/`host.ts`.
- `ext-ui` (`5cb9acd`): `capabilities.supportsUi?: boolean` is a data field on
  `HarnessCapabilities` (`spec.ts`), read uniformly by `host.ts:389,407`
  (`if (!this.child || !this.capabilities.supportsUi) return false;`) — no
  harness-id branch. `PI_CAPABILITIES` (pi/runtime.ts) does NOT yet set
  `supportsUi: true` — meaning today NO harness declares the capability, so
  the new protocol frames are exercised only by the `stub` harness in
  `test/runner-host.test.ts`. Correct posture (uniform mechanism, zero
  producers yet) — not a violation, a GAP already counted in §1/§4.
- One fragility worth flagging though it is not a RULE #0 violation:
  `9c6f95f`'s fix reaches into `DefaultResourceLoader`'s `packageManager`
  field via `(loader as unknown as { packageManager: PackageManager })`
  because the SDK exposes no public `onMissing` hook — TS-private, JS-public
  at runtime, and the commit documents this precisely. A future pi SDK bump
  renaming/relocating that field breaks this silently; recommend a startup
  assertion (`typeof packageManager.resolve === "function"`) rather than
  relying on the type-check to catch drift, since a JS-runtime field rename
  would NOT surface as a `tsc` error against a `.d.ts` that also renamed it.

## §6 design-node drift — CONFLICT

**Sandbox/trust bypass (the load-bearing finding).** AGENTS.md RULE (root):
"Trust is data: `trust: false` → forced real sandbox, never
config-weakenable." This protocol governs `RunnerHost` spawning a harness
subprocess (`src/harness/host.ts`, `sandboxPaths` on `HarnessSpec`). It has
**no jurisdiction at all** over manifest plugin contribution code:

- `src/services/plugins/loader.ts` `importPluginModule` (`loader.ts` ~24-42)
  compiles the plugin's entrypoint with `Bun.build` and dynamically `import()`s
  the resulting Blob URL **in the daemon's own process** — no subprocess, no
  `node:vm`, no capability trap of any kind.
- `registry.ts` `#register` (`registry.ts` ~230-250) calls
  `register.call(loaded.module, context)` directly — the plugin's arbitrary
  top-level and `register()` code runs with full daemon authority the instant
  it loads, BEFORE any `CapabilityBroker.authorize()` call ever happens
  (`contracts.ts`'s `authorize()` gates COMMAND/TOOL/CHANNEL/PROVIDER
  INVOCATION, not module load or the plugin's own module-scope code).
- Discovery (`loader.ts:53-57` `pluginDiscoveryRoots` →
  `globalPaths.commandPluginsDir()` = `src/core/paths.ts:54`
  `join(gaiaHome(), "plugins")` = `~/.gaia/plugins`) is a GLOBAL,
  daemon-boot-time root — not scoped to any room, agent, or trust tier.
  Whatever `trust:false` means for an agent's OWN harness subprocess, it says
  NOTHING about what code a plugin dropped in `~/.gaia/plugins/` can do —
  that code always runs as the daemon.

This is not hypothetical: the entire `CapabilityBroker`/`requiredCaps`
machinery (§2) is COOPERATIVE — it authorizes an invocation, it never
constrains what the already-loaded, already-running plugin code is
**capable** of doing in the same process. Compare deepseek's own
`cordis-host-runner/sandbox.ts` (§2): a real (if leaky) realm boundary +
Node-API traps. v1 has adopted zero realm isolation for a system that the
doctrine explicitly wants to make MORE extensible, i.e. exposed to MORE
third-party code, not less. **Fix direction: adopt v2's `sandbox.ts`
`SandboxProvider` (§3) for plugin module execution, or at minimum a
deepseek-style `node:vm` + capability-trap realm, before broadening plugin
discovery/publishing.**

**Stale design node.** `DESIGN-ARCHTREE.md:14` (dated, part of the
archtree-visualizer recon, not this plugin work — but still a live doc node
referenced by the doctrine's "design nodes still honoured" clause) describes
"zwei Systeme: (a) Command-Plugins `.mjs` (`src/services/plugins.ts`) —
data-only Panels … (b) Package-Plugin-Host (`src/services/plugin-host.ts`)
— registriert services, kein UI". Read live: `src/services/plugin-host.ts`
does **not exist** (`ls` → ENOENT); `src/services/plugins.ts` is a 75-line
ADAPTER (`src/services/plugins.ts:1-2` "Command-plugin compatibility
surface. Commands enter only through daemon-owned manifest registries; this
adapter binds their typed result to room hooks.") over the NEW
`services/plugins/{contracts,registry}.ts` — the two-system description this
node makes is already obsolete relative to code on `main`, independent of
`pi-ext`/`ext-ui`. Not this PR's regression, but a drifted node that should
be corrected or retired so the NEXT plugin doc doesn't cite it as current.

**Layering** — PASS. `services/plugins/*` sits in `services/`, imports only
`core`+`domain`-level types and `services/capabilities/*` (same layer);
`services/room/commands-facade.ts` importing `services/plugins/registry.ts`
is services-importing-services, permitted. No upward imports found.

**Durability protocol alignment** — PASS (design reuse, not violation).
`registry.ts`'s `PluginTurnBoundary` (`beginTurn`/`applyTurnBoundary`,
generation-keyed staged candidate) mirrors DESIGN.md's "commit only at a
safe boundary" philosophy (WAL commit only after a turn settles) — a correct
application of the same principle to a different subsystem, not drift.

## §7 two-format debt — CONFLICT, gaia format should die (except channels)

`~/projects/gaia-plugins/docs/README.md` (site doctrine, dated 2026-09-05 —
SAME DAY as this branch): "Doctrine (Pascal 09-05): gaia is pi-first. A
'gaia plugin' = a **pi package** … No parallel gaia-only plugin format —
`~/.gaia/plugins/*` daemon-native plugins (own `plugin.json`,
`engine: gaia-daemon`) are NOT pi packages and are intentionally excluded
from this registry."

Read live against `src/services/plugins/manifest.ts`:

- `manifest.ts:6` `MANIFEST_KEYS = new Set(["id", "version", "engine",
  "placement", "process", "requiredCaps", "contributes"])`
- `manifest.ts:24` `readonly engine: string;`
- discovery root confirmed above (§6) = exactly `~/.gaia/plugins`.

This is EXACTLY the format the store's doctrine document, written the same
day, already excludes and calls dead. Two live formats exist RIGHT NOW on
`main`, being actively extended (`registry.ts`, `contracts.ts`) in parallel
with the store publicly declaring one of them non-existent policy.

**One adapter is not enough — gaia format should die for 3 of 4 contribution
kinds, survive for the 4th:**

- `commands`, `tools`, `providers` (`contracts.ts:47-63`
  `PluginCommandContribution`/`PluginToolContribution`/`PluginProviderContribution`)
  all have a DIRECT pi ExtensionAPI equivalent (`registerCommand`/`registerTool`/
  `registerProvider`) — MIGRATE these to pi packages, retire the gaia manifest
  path for them. (`registerCommand`'s reachability gap from §1/§4 must be
  fixed FIRST, or migrating away from the gaia-native command path actively
  regresses command plugins today — sequencing matters, see top-fix #2.)
- `channels` (`contracts.ts:57` `PluginChannelBridgeContribution`) has **NO**
  pi ExtensionAPI equivalent (§4 table) — pi's `ExtensionAPI` has no
  channel/transport concept at all. AGENTS.md: "Channel bridges (Telegram/
  Discord/…) = plugins, never core." This ONE kind must keep a gaia-native
  contribution path; recommend narrowing `src/services/plugins/*` to
  channel-bridges ONLY once commands/tools/providers migrate, rather than
  running two full parallel systems indefinitely.

## §top-5 fixes, ranked by impact

1. **Sandbox the plugin execution path (§6).** Manifest-plugin module code
   runs with full, unwrapped daemon-process authority regardless of any
   room/agent trust tier — the ONE execution path in the whole codebase the
   "Trust is data" protocol doesn't reach. Adopt v2's `SandboxProvider`
   (§3) or a deepseek-style `node:vm` + capability-trap realm (§2) before
   this system's surface (discovery, publishing, third-party authors) grows
   further under the "as extensible as possible" doctrine — more
   extensibility here currently means more unsandboxed code, not more.
2. **Resolve the two-format conflict (§7) with a migration order, not a
   freeze.** Store doctrine already declared the gaia-native format dead;
   `main` is actively building it. Decide + execute: migrate commands/tools/
   providers to pi packages, keep gaia-native ONLY for channel-bridges. Do
   this AFTER fix #4 (registerCommand reachability), or command plugins lose
   their only working path mid-migration.
3. **Fix `forwardPiEvent`'s silent event drop (§1/§4).** `src/harness/pi/events.ts`
   allowlists 9 of ~25 `ExtensionEvent` kinds with no default/log branch —
   any pi extension using `session_*`/`turn_*`/`agent_*`/`sendMessage` custom
   messages is invisible to a gaia room with zero diagnostic trace. Minimum
   fix: log-and-drop with a visible `ext.lifecycle`-style notice (the
   AgentEvent kind ext-ui already defined, `5cb9acd`) instead of silent loss,
   even before deciding which of these deserve full forwarding.
4. **Wire `registerCommand` reachability (§1/§4).** `services/room/queue.ts`'s
   `parseCommand` + skill-allowlist owns every `/word` message before the
   harness runs; `PiRuntime.send()` never calls into pi's own command
   dispatch. Add: unknown gaia command + the agent's active pi session has a
   registered command of that name (`session.getCommand`/`getCommands()` per
   `types.d.ts`) → dispatch through pi's own `ExtensionCommandContext`
   handler instead of falling through to "unknown command". Without this,
   "pi package = gaia plugin natively" is false for the single most common
   extension surface (slash commands).
5. **Finish Lane A ⇄ Lane B integration + close the branch-durability gap it
   exposed.** `ui-bridge.ts`/protocol/web wiring (`ext-ui`) is fully built
   and unit-tested but has ZERO producer: `PI_CAPABILITIES` never sets
   `supportsUi: true`, `PiRuntime` never calls `createUiBridge` or
   `session.bindExtensions({ uiContext: … })` (the exact call site `ui-bridge.ts`'s
   own top-of-file comment documents but explicitly says "not created here").
   Wire it per that comment. Separately: this entire branch's work sat as
   UNCOMMITTED worktree diff (not on the `ext-ui` branch at all, by git's own
   reckoning) until it landed as `5cb9acd` mid-review — a timeout on that
   summon would have discarded it per the harness's own "summon timeouts eat
   the ROOM, not committed work" law. Commit-every-stage discipline applies
   to Lane B same as any other lane.

## §commit

This document: branch `room/chat-mto9n58s-bjr1/pi-ext`, commit message
`docs: plugin adversary review 0905` (sha recorded after commit below).
No code changed by this review.
