# Plugin-system recon · deepseek × v2 × v1

## §scope

- sources·2026-09-02 → deepseek `49a606bc5b5934603f22a26957a07dc799ab0291` · v2 tree · v1 tree
- axes → manifest · discovery/load · lifecycle · authority · isolation · config · registrations · compat
- terms → deepseek = Cordis composition/plugin runtime · v2 = `addons/` manifest loader · v1 = current command+runner seams

## §deepseek

- shape → Cordis plugin function `(ctx, config)` | class `(ctx, config)` | `{ apply(ctx, config) }`; metadata `{name?, Config?, inject?, provide?, intercept?}`
- config entry → YAML `EntryOptions` `{id,name,config?,group?,disabled?,inject?}` + isolate extension `{intercept?,isolate?}`
- discovery → named profile → `cordis.yml` empty root + package `dsh.profile.bundles` layers + profile `cordis.patch.yml` + `$DSH_HOME/cordis.patch.yml` + argv `--patch`; ordered composition
- load → Loader imports `cordis:` builtin | relative URL against `baseUrl` | package specifier; unwrap default/CJS exports; stable entry IDs
- tree → nested `group`; dynamic `create/remove/update`; config persistence delegated to EntryTree; entry update rollback restores old tree
- lifecycle → Fiber `PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED|FAILED`; missing injected provider = PENDING, not implicit failure
- lifecycle API → `ctx.plugin(plugin,...args)`→Fiber · `ctx.inject(deps,callback)` re-runs on provider change · `ctx.effect(()=>disposer)` · `ctx.on()`/registries auto-unwind on unload
- reload → HMR replaces changed module; config diff keyed by `id`; changed `name|inject|group` restart; config-only update invokes fiber update; rollback on failed update
- hooks → typed/reorderable events/waterfalls; examples `tools/pre-execute(exec,next): Promise<PreToolDecision>` · `tools/execute` wrap · `tools/post-execute` transform · `tools/result` observe · `session/event`
- tools → `ctx.tools.register()` / typed `defineTool`; MCP server adapter discovers then registers tools; tool visibility/enforcement via `ctx.tools.restrict()`
- providers → services via `provide`/`inject`; LLM adapters registered through `registerAdapter`; subagent provider registry → one selected provider tool
- channels → protocol-driver plugin maps wire peer↔`ctx.agents`; inbound `followup()`/`cancel()`, outbound `session/event`; UI likewise session event observer + agent input
- authority → no package permission manifest gate in loader; Cordis service dependencies/control are cooperative; tool policy via hooks/guards + sandbox backend; `!!js` evaluates in loader context
- isolation → in-process same JS realm; `isolate: {service: true|label}` remaps service symbols locally/shared-label; `intercept` alters dependency config; not OS/process isolation
- config → schema `Config` validates plugin config; loader YAML entries + `!!js` interpolation; profile patches reusable/live; launch env snapshot supplied before entries mount
- compat → package/module semver external ecosystem; no loader-level engine compatibility field; Node internal-loader adapter feature-detects v1/v2 shapes rather than Node major
- limits → in-process arbitrary imported code + `!!js`; no capability-bearing manifest boundary; HMR source loading depends on Node internals

## §v2

- manifest → strict `plugin.json` exact keys `{name,version,engine,entrypoint,permissions,requiredCaps}`; package-name + semver validation; arrays unique/patterned
- discovery → `<projectRoot>/addons/*/plugin.json`, lexical directory-name order; missing root → empty; all manifests validate before code import
- load → `realpath` package+entrypoint; `./` entrypoint file must remain inside package after symlink resolution; duplicate names reject; import file URL with generation cache-buster
- register signature → `register(context: {manifest,packageRoot,stateRoot,generation}): PluginRegistration|Promise<...>`; accepted default function/default object/named `register`
- registration → `{status:"available"|"unavailable", unavailableReason?, commands?: {name,description}[], services?: Record, dispose?}`; unavailable reason + shape validated; loader exposes immutable public copy
- lifecycle → boot sequentially under keyed registry queue; register all staged entries then atomic map swap; prior disposers after successful swap
- reload → `stageReload()` validates manifests only; `applyTurnBoundary()` only with zero active leases; generation increments; failed registration retains active registry; `PluginTurnLease.end()` unblocks boundary
- room coupling → `beginTurn()` snapshot before execution; RoomService ends lease then applies staged reload; emits `plugin.reloaded|plugin.reload_failed`; HTTP POST `/api/plugins/reload` stages + applies or `ROOM_BUSY`
- hooks → no generalized plugin lifecycle/event hook ABI; explicit backend seam `BackendPlugin.handle(frame)` accepts typed `turn|abort|steer|restore|compact|fork`; steering helper `persistBeforeSteer()` → persist→try→marker|ordinary-turn
- tools/providers/channels → metadata-only `commands`, opaque `services`; no host registry that mounts tools/providers/channels; concrete plugin behavior must arrive through separately wired service objects/backend adapter
- authority → `requiredCaps` checked per `PluginTurnLease.invoke(pluginId,operation,invoke,input)` through app CapabilityService; request must carry room+agent; deny if resolver absent; permissions declarative only—loader never enforces `permissions`
- isolation → in-process dynamic import; per-plugin durable state directory `profile/plugins/state/<encoded id>`; no subprocess/sandbox boundary supplied by loader
- config → manifest-only config; no arbitrary plugin config schema/profile layering; host constructs registration context
- compat → semver `version` syntax validated; free-form `engine` only bounded string—no range evaluation/enforcement; `permissions` syntactically validated only
- limits → plugin `services` untyped/opaque; no registration broker; no manifest capability→operation mapping beyond requiredCaps; no unload rollback if a prior-disposer fails after swap

## §v1-today

- command plugin shape → default-export `.mjs` `CommandPlugin`: `{command:string|string[],id?,description?,run(args,ctx),panel?,prompt?,renderCap?,turnStart?}`
- context/result → `PluginContext {homedir,roomId,workspaceRoot,state?,agents,command?}`; `run` returns `{steer?,reply?,activeAgent?,state?,rewriteAsMessage?,targets?}`
- discovery → bundled `plugins/defaults/*.mjs` first → `~/.gaia/plugins/*.mjs`; filename sort; optional dirs; bundled command owns collision; invalid/import-failed module warns+skips
- lifecycle → imported during service construction; no manifest, init/dispose ABI, generation, reload, or transactional registry replacement; plugin state sanitized/bounded JSON in durable `RoomState.pluginState`
- hooks → command `run`; optional `panel`, per-target `prompt`, commit-time `renderCap`, pre-turn `turnStart`; RoomService resolves once and shared `AgentInput.pluginContext` reaches every harness via shared prompt seam
- UI → declarative data-only `PluginPanel` projected in snapshot: title/description/forms/items; no iframe/browser-owned plugin surface
- command delivery → `steer|reply` synthetic paths or `rewriteAsMessage` re-enters normal busy/queue/steer pipeline; target selection bounded to known agents
- runner plugin shape → `~/.gaia/plugins/runner/*.mjs`; default/module `{name?,wrapFetch?(next):FetchFn}`; filename-ordered composition onto `globalThis.fetch`; runner installs before uniform harness runtime creation
- harness extension → `registerHarness(spec)` per `src/harness/<x>.ts`; data `capabilities`/`ui`/`credentialProxy`/other descriptor wiring; `RunnerHost` applies uniformly; harness ID branches forbidden in shared layer
- harness protocol → newline JSON `RunnerCommand turn|abort|steer|compact|...` ↔ `RunnerMessage ready|event|turn-end|...`; shared `AgentRuntime` methods/capabilities carry every harness feature
- channels → no channel bridge plugin ABI today; AGENTS requirement: bridges plugins, never core; present voice/internal bridges are service code, not generalized external plugin contract
- tools/providers → command plugins cannot register Gaia tools/providers; runner plugin only fetch interception; harness specs declare native/Gaia tool capability data, each runtime translates locally
- authority → command plugin receives filesystem paths + in-process authority; no declared permissions/caps/operation broker; runner plugin executes in already sandboxed runner but can alter every outbound fetch
- isolation → command plugins execute in daemon process; runner plugins execute in runner subprocess; no per-plugin process/realm/state root; runner sandbox is turn/harness boundary, not plugin boundary
- config → code-only ambient context/state; no manifest/schema/version/engine/config-file contract; bundled assets shipped with binary snapshot
- compat → load-time duck typing only; command aliases collision check; no semver/engine/ABI negotiation

## §diff-table

| axis | deepseek | v2 | v1-today |
|---|---|---|---|
| manifest | YAML entry `{id,name,config,…}`; module metadata | strict `plugin.json` | none; duck-typed `.mjs` |
| discovery | profiles→bundle/user/home/argv patches | `addons/*/plugin.json`, lexical | bundled defaults→`~/.gaia/plugins`; runner subdir |
| load | Cordis import/builtins; dependency fibers | validate-all→sequential register→atomic map | dynamic import; warn+skip |
| lifecycle | Fiber/effects/disposer/HMR+rollback | register/dispose; staged boundary generations | command hooks only; no dispose/reload |
| hooks | typed events/waterfalls; broad extension graph | backend frames + steer helper; no general bus | `run/panel/prompt/renderCap/turnStart` |
| capability | cooperative services + tool guards/sandbox | `requiredCaps` operation authorization; `permissions` inert | no plugin capability declaration/broker |
| isolation | in-proc; service-symbol realms | in-proc; isolated state directory only | daemon/runner process placement; no per-plugin isolation |
| config | schema + YAML patches + `!!js` | fixed manifest fields | ambient context + opaque room JSON |
| tool/provider/channel registration | registries/services/protocol drivers | metadata/opaque services; no host registry | no generic ABI; harness spec data; fetch wrapper |
| compat | ecosystem package semver; Node-loader shape probe | version syntax; `engine` stored-not-checked | none |

## §steal-list

- manifest-first validate-all→import · reject duplicate IDs/path escape before code · `services/plugins` manifest validator + loader; server discovers only
- staged registry + turn lease · no mixed plugin generations mid-room turn · `services/plugins` + RoomService turn-finally boundary; daemon endpoint only stages
- capability invocation broker · manifest `requiredCaps` checked per operation with `{roomId,agentId}` · `services/capabilities` resolver + `services/plugins` facade; never plugin self-policing
- lifecycle disposer + atomic replacement · old plugin survives failed reload; teardown ownership explicit · `services/plugins` registry; RoomService only consumes snapshot
- typed registration ports · command/tool/channel/provider/backend contributions explicit contracts, not opaque `services` · `services/plugins` contracts → `harness/protocol` for runner wire; harness adapters data-only
- package-root/state-root confinement · realpath containment + one encoded durable state dir/plugin · `services/plugins`; state schema in domain, persistence via daemon
- declarative plugin panel retained · v1 data-only snapshot panel is safer than arbitrary browser injection · preserve `services/plugins`→server projection boundary
- runner fetch seam retained · one uniform pre-runtime hook across all harnesses · `harness/runner-plugins` only; do not reimplement per harness

## §non-goals

- non-goal → port DeepSeek `!!js` config evaluation; capability boundary defeated by ambient code execution
- non-goal → copy Cordis framework/HMR/Node-internal loader; v1 compiled Bun daemon + no dev watcher policy
- non-goal → expose arbitrary plugin browser UI/iframes; retain data-only panels or explicit versioned client protocol
- non-goal → harness-specific plugin paths/branches; all harness variance remains spec descriptor data
- non-goal → treat manifest `permissions` as security until operation broker maps/enforces every permission
- non-goal → replace sandbox/trust with user approval; `trust:false` keeps forced real sandbox
