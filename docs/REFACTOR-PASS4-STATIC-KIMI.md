# Refactor Pass 4 — Static Audit (Kimi)

## Bhairava review

### Scope

- Baseline: `b98c3ce`; reviewed range: `4fda75d..338db79`.
- Branch: `room/chat-mtk78q14-wa40`; checkpoint: `2622937`.

### PASS — capability / trust floor

- `rg -n -i 'provider|model' src/services/capabilities src/services/plugins`: only declarative provider-contribution plumbing plus resolver comment; no provider/model conditional, security gate, or harness-id branch.
- Read `resolveWorkspaceTrust` + `resolveWorkspaceGrantPolicy`: trust derives only from resolved workspace agent; grants derive only from `config.plugins.grants[agentId]` + agent `capabilities`.
- Weakening attempt: constructed `trust:false` agent with both agent capability `network` and workspace `plugins.grants[agentId]=[network]` (existing real-source fixture, `test/capabilities-daemon-sources.test.ts:103`). Expected deny; actual `{ allowed: false, missing: ["network"] }`.
- Independent broker weakening: all-capabilities `grantSource` + `trustSource: () => false`; expected empty grants and zero grant-source calls; actual pass (`test/plugins-capabilities.test.ts:108,117`).
- Gate: `bun test test/capabilities-daemon-sources.test.ts test/plugins-capabilities.test.ts test/plugins-loader.test.ts test/plugins-manifest.test.ts test/bundled-plugins.test.ts` → 31 pass, 0 fail.

### PASS — layering / RULE0

- `rg -n 'daemon\\.js|/daemon\\.js|\\.\\./daemon' src/services/capabilities src/services/plugins` → zero hits.
- `rg -n -i 'provider|model' ...` → no identity-based authority decision.
- `rg -n '(harness ===|harness !==|@ts-ignore|@ts-nocheck|eslint-disable)' src/services/capabilities src/services/plugins` → zero hits.

### Ticket STATIC-001 — bundled RPG behavior contradicts opt-in description

- Severity: low / documentation-behavior mismatch.
- Hash: `338db79` range.
- Repro: `bun test test/bundled-plugins.test.ts`; inspect `src/services/plugins/loader.ts:16-20`, `plugins/rpg.mjs/plugin.json`, `src/core/bundle-assets.ts:12-16`.
- Expected: comment says `rpg.mjs` is a reference example users copy into `~/.gaia/plugins/` to opt in.
- Actual: `plugins/rpg.mjs/plugin.json` is a valid direct-child package with `placement:"daemon"`; bundled `plugins` is the first discovery root and the bundled test stages every daemon package. It loads at boot (currently contributes nothing).

### Ticket STATIC-002 — public exports lack non-test external call site

- Severity: low / dead public API surface.
- Hash: `338db79` range.
- Repro: `rg -n '\\b(RegistryLifecycleError|PluginTurnLease)\\b' src --glob '*.ts'`.
- Expected: every `src/services/plugins/*` / `src/services/capabilities/*` export has a non-test call site outside its defining module.
- Actual: `RegistryLifecycleError` and `PluginTurnLease` occur only in `src/services/plugins/registry.ts`; no external production consumer.

### Export inventory / production consumers

- capabilities: resolver→broker/index; daemon-sources→daemon/index; broker functions/classes→contracts/registry/daemon/index; types→daemon + services/harness/domain consumers.
- plugins: manifest read/discover/revalidate→loader; loader roots→daemon, load→registry; contracts validators/invokers→registry; registry→daemon/room-service/plugins facade/policies/monad; interfaces/types consumed by those module contracts.
- Exceptions: STATIC-002 only. `PluginManifestError` is constructed internally by manifest validation; `CapabilityDeniedError` is constructed by broker and caught/typed by contracts/tests.

### Unverified

- No daemon/UI live path run (static scope; no daemon launch).
