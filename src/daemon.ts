// The composition root. Owns every cross-room, cross-workspace concern the v1
// server buried inside HTTP handlers: workspace registry, per-room services
// (LRU, busy-aware), per-workspace memory stores + summon coordinators, the
// harness bridge, the voice call session, thinking scoping, settings
// hot-reload, and the UI event bus. The HTTP server (server/http.ts) is a pure
// route table over this class.

import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Bus } from "./core/bus.js";
import { globalPaths, workspacePaths } from "./core/paths.js";
import { readJson, writeJsonAtomic } from "./core/store.js";
import type { AgentDef, ChatSearchHit, ChatSearchResult, KeepAwakeCapability, PetBinding, RoomState, Snapshot, UiEvent, UsageLimits, VoiceCallInfo, Workspace, WorkspaceRecord } from "./core/types.js";
import { capabilitiesFor, type ContextDietView, type GaiaTool, harnessIdFor } from "./harness/spec.js";
import type { ContextDietOverrides } from "./domain/context-diet.js";
import { reapOrphans } from "./harness/reaper.js";
import type { MemoryAction, MemoryMutationResult } from "./domain/memory.js";
import { MemoryStore } from "./domain/memory.js";
import { RoomHandle } from "./domain/rooms.js";
import { listWorkspacePetBindings } from "./domain/pets.js";
import { loadWorkspace, workspacePath } from "./domain/workspace.js";
import { ensureAccountsFile } from "./domain/accounts.js";
import { RoomService, scanRoomActivity } from "./services/room-service.js";
import { CapabilityBroker } from "./services/capabilities/broker.js";
import { resolveWorkspaceGrantPolicy, resolveWorkspaceTrust } from "./services/capabilities/index.js";
import { PluginRegistry, type PluginRegistryEvent } from "./services/plugins/registry.js";
import { pluginDiscoveryRoots } from "./services/plugins/loader.js";
import { MemoryService } from "./services/memory-service.js";
import { UsageService } from "./services/usage-service.js";
import { EmbedSidecar } from "./services/embed-sidecar.js";
import { SchedulerService } from "./services/scheduler.js";
import { formatDreamProposal } from "./services/consolidate.js";
import type { ConsolidateResult } from "./services/consolidate.js";
import { formatMemoryHits, scrollTranscriptWindow, type MemoryHealthRow, type MemorySearchHit } from "./domain/workspace-index.js";
import { SummonCoordinator } from "./services/summons.js";
import { HarnessBridge, type HarnessTokenClaims } from "./services/bridge.js";
import { resolveUpstreamCredential, type UpstreamCredential } from "./services/proxy.js";
import { EditableFileRegistry, buildFileHints, readModelCatalog, sdkThinkingLevels, sdkToolNames, skillHintOptions, type EditableFileContent, type EditableFileDescriptor, type FileHints, type HintSources, type ModelChoice } from "./services/hints.js";
import { ensureVoiceSettingsFile, sweepOrphanOverrides } from "./services/voice.js";
import { KeepAwakeManager, keepAwakeCapability, migrateLegacyLaunchdAgent, readKeepAwakeSetting, writeKeepAwakeSetting } from "./services/keep-awake.js";
import { readThemeSetting, writeThemeSetting } from "./services/theme.js";
import { readUserNameSetting, writeUserNameSetting } from "./services/user-name.js";
import { createToolProviders } from "./services/tool-providers.js";
import type { ToolProviders } from "./harness/protocol.js";
import {
coordinatorFor as wireCoordinatorFor,
memoryServiceFor as wireMemoryServiceFor,
recoverPendingTurns as wireRecoverPendingTurns,
recoverSummons as wireRecoverSummons,
serviceFor as wireServiceFor,
serviceKey,
} from "./daemon/wiring.js";
import {
  applySettingsChange as reloadApplySettingsChange,
  reloadService as doReloadService,
  workspaceServiceKeys as wireWorkspaceServiceKeys,
} from "./daemon/reload.js";
import type { HarnessApiPort, ReloadHost, WiringHost, RoomInteractionHost } from "./daemon/ports.js";
import { RoomInteractionLifecycle } from "./daemon/interactions.js";
import { harnessContextDietGet, harnessContextDietSet, harnessDogCommand, harnessDreamApply, harnessDreamPropose, harnessEndConversation, harnessGaiaTools, harnessGhoulLedgerSearch, harnessGhoulRoomRead, harnessMemoryBatch, harnessMemoryWrite, harnessRecall, harnessRecallScroll, harnessToolProviders, harnessToolResultFetch } from "./daemon/harness-api.js";

// --- workspace registry (recent workspaces in ~/.gaia/app.json) ----------------
// Registry entries are the WorkspaceRecord wire shape from core/types.ts.

function pathId(path: string, length: number): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, length);
}

function normalizeRecord(path: string, lastOpenedAt = new Date().toISOString(), humanId?: string, favorite?: boolean, order?: number): WorkspaceRecord {
  const resolved = resolve(path);
  const parts = resolved.split(/[\\/]/).filter(Boolean);
  return {
    // Preserve every legacy/shared id; an owned record includes its owner so
    // two scopes can never alias the same live-service/cache key.
    id: pathId(humanId ? `${humanId}\0${resolved}` : resolved, 16),
    path: resolved,
    name: parts[parts.length - 1] ?? resolved,
    lastOpenedAt,
    isInitialized: existsSync(workspacePath(resolved)),
    ...(humanId ? { humanId } : {}),
    ...(favorite ? { favorite: true } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

export class WorkspaceRegistry {
  constructor(private readonly configPath = globalPaths.appSettings()) {}

  async list(): Promise<WorkspaceRecord[]> {
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    return (config.recentWorkspaces ?? [])
      .map((record) => normalizeRecord(record.path, record.lastOpenedAt, record.humanId, record.favorite, record.order))
      .sort((a, b) => {
        // Favorites always lead (sidebar "favorites on top"), then explicit
        // drag order (see reorder()), then most-recently-opened for anything
        // never dragged.
        if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
        if (a.order !== undefined) return -1;
        if (b.order !== undefined) return 1;
        return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
      });
  }

  /** Human-visible registry slice. `undefined` is the legacy shared scope. */
  async listForHuman(humanId?: string): Promise<WorkspaceRecord[]> {
    return (await this.list()).filter((record) => record.humanId === humanId);
  }

  async add(path: string, humanId?: string): Promise<WorkspaceRecord> {
    const resolved = resolve(path);
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    // Re-adding an already-registered path (re-picking the same folder) must not
    // wipe its favorite/manual order -- carry them over onto the bumped record.
    const existing = (config.recentWorkspaces ?? []).find((item) => resolve(item.path) === resolved && item.humanId === humanId);
    const record = normalizeRecord(path, undefined, humanId, existing?.favorite, existing?.order);
    const next = [record, ...(config.recentWorkspaces ?? []).filter((item) => item.id !== record.id || item.humanId !== humanId)].slice(0, 30);
    await writeJsonAtomic(this.configPath, { ...config, recentWorkspaces: next });
    return record;
  }

  async find(id: string): Promise<WorkspaceRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async findForHuman(id: string, humanId?: string): Promise<WorkspaceRecord | undefined> {
    return (await this.listForHuman(humanId)).find((record) => record.id === id);
  }

  /** Drop a workspace from the recent-workspaces list. De-registration only —
   * the folder on disk (project files + .gaia data) is never touched, so
   * re-adding the path restores it. Returns false if the id wasn't listed. */
  async remove(id: string, humanId?: string): Promise<boolean> {
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    const list = config.recentWorkspaces ?? [];
    const next = list.filter((item) => item.id !== id || item.humanId !== humanId);
    if (next.length === list.length) return false;
    await writeJsonAtomic(this.configPath, { ...config, recentWorkspaces: next });
    return true;
  }

  /** Mark/unmark a workspace favorite (sidebar right-click "Add/Remove
   * favorite", same UX as room favorites) — display metadata only; sort order
   * (favorites first) is applied in list(). Returns false if the id isn't
   * registered for this human scope. */
  async setFavorite(id: string, favorite: boolean, humanId?: string): Promise<boolean> {
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    const list = config.recentWorkspaces ?? [];
    const index = list.findIndex((item) => item.id === id && item.humanId === humanId);
    if (index === -1) return false;
    const next = [...list];
    const { favorite: _drop, ...rest } = next[index];
    next[index] = favorite ? { ...rest, favorite: true } : rest;
    await writeJsonAtomic(this.configPath, { ...config, recentWorkspaces: next });
    return true;
  }

  /** Persist a sidebar drag-drop reorder: `ids` is the full desired order for
   * this human scope (favorites-and-non alike — favorite-on-top is a separate
   * sort pass in list(), so a drag can freely reorder within/across both).
   * Ids outside this scope are left untouched; ids never passed here keep
   * their prior order/lastOpenedAt-only ordering. */
  async reorder(ids: string[], humanId?: string): Promise<void> {
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    const list = config.recentWorkspaces ?? [];
    const position = new Map(ids.map((id, index) => [id, index]));
    const next = list.map((item) => {
      if (item.humanId !== humanId) return item;
      const order = position.get(item.id);
      if (order === undefined) return item;
      return { ...item, order };
    });
    await writeJsonAtomic(this.configPath, { ...config, recentWorkspaces: next });
  }
}

// --- the daemon -----------------------------------------------------------------

function pluginLifecycleLog(event: PluginRegistryEvent): string {
  switch (event.kind) {
    case "staged": return `plugin registry: staged generation=${event.generation} plugins=${event.pluginIds.join(",")}`;
    case "stage-failed": return `plugin registry: stage-failed generation=${event.generation} reason=${event.reason}`;
    case "swapped": return `plugin registry: swapped generation=${event.generation} previousGeneration=${event.previousGeneration} plugins=${event.pluginIds.join(",")}`;
    case "disposed": return `plugin registry: disposed generation=${event.generation} plugin=${event.pluginId}`;
    case "dispose-failed": return `plugin registry: dispose-failed generation=${event.generation} plugin=${event.pluginId} reason=${event.reason}`;
  }
}

export interface DaemonOptions {
  cwd: string;
  log?: (message: string) => void;
}


export class Daemon {
  readonly registry = new WorkspaceRegistry();
  readonly files = new EditableFileRegistry((id) => this.workspaceForId(id));
  /** One daemon-owned plugin generation boundary, injected into every room. */
  readonly pluginRegistry = new PluginRegistry({
    pluginsRoot: pluginDiscoveryRoots(),
    placement: "daemon",
    importer: (entrypoint) => import(pathToFileURL(entrypoint).href),
    // Real sources, not the always-deny stub: resolve off this daemon's OWN
    // resident RoomService cache (#liveWorkspaceFor), synchronously —
    // CapabilityGrantSource/CapabilityTrustSource are sync by contract
    // (services/capabilities/types.ts), so no I/O happens here. A context
    // whose room isn't presently live resolves to workspace=undefined, which
    // both daemon-sources.ts functions fail CLOSED on (no grants, untrusted)
    // — never inferred open. Arrow functions close over `this`, evaluated
    // lazily at call time (after full construction), so field-init order is
    // safe even though `services` is declared further below.
    capabilityBroker: new CapabilityBroker({
      grantSource: (context) => resolveWorkspaceGrantPolicy(this.#liveWorkspaceFor(context.workspaceId, context.roomId), context.agentId),
      trustSource: (context) => resolveWorkspaceTrust(this.#liveWorkspaceFor(context.workspaceId, context.roomId), context.agentId),
    }),
    onEvent: (event) => this.log(pluginLifecycleLog(event)),
  });
  /** "Keep laptop awake" (Global Settings ▸ General) — see services/keep-awake.ts. */
  private readonly keepAwakeManager = new KeepAwakeManager({ log: (message) => this.log(message) });
  // Non-private: daemon/wiring.ts + daemon/reload.ts read/mutate this directly
  // through the WiringHost/ReloadHost structural interfaces (A7 split);
  // callers outside Daemon never see it (not part of the public surface).
  readonly services = new Map<string, RoomService>();
  /** serviceKey -> epoch ms of the most recent `serviceFor` hand-out. Guards the
   * eviction race: a service is protected while a caller's in-flight operation
   * (e.g. sendMessage's init+routing, before activeTask is set) completes. */
  readonly handedOutAt = new Map<string, number>();
  /** serviceKey -> in-flight creation. Two concurrent cache misses for the same
   * room (SSE reconnect burst right after a restart) must share ONE creation:
   * independent RoomService instances each run initOnce — double pendingTurn
   * resume, two runner subprocesses, racing writes to the same state.json. */
  readonly servicePending = new Map<string, Promise<RoomService>>();
  readonly currentRoom = new Map<string, string>();
  readonly memoryStores = new Map<string, MemoryStore>();
  /** Service-side tool implementations injected into subprocess harnesses. */
  private readonly toolProviders = createToolProviders();
  readonly memoryServices = new Map<string, { service: MemoryService; live: { workspace: Workspace } }>();
  /** One local embedding sidecar per daemon (model server shared across
   * workspaces); MemoryService reaches it through EmbedderDeps. Download and
   * startup progress fans out to every workspace's health table — a 300MB
   * model pull must be visible, not a buried log line (§10). */
  readonly embedSidecar = new EmbedSidecar({
    log: (message) => this.log(message),
    onProgress: (state, detail, role) => {
      for (const { service } of this.memoryServices.values()) service.noteSidecarProgress(role === "rerank" ? "reranker" : "embedder", state, detail);
    },
  });
  readonly summonCoordinators = new Map<string, SummonCoordinator>();
  private readonly bus = new Bus<UiEvent>();
  readonly pendingReloads = new Set<string>();
  /** Subscription-usage meter (account-keyed, disk-cached, self-polling) —
   * see services/usage-service.ts. The daemon only wires broadcast + lifecycle. */
  private readonly usageService = new UsageService({ broadcast: (event) => this.broadcast(event) });
  hintSourcesCache: { toolNames: string[]; models: ModelChoice[] } | undefined;
  bridge: HarnessBridge | undefined;
  scheduler: SchedulerService | undefined;
  // Resolves once boot()'s orphan sweep has finished. serviceFor() awaits this
  // so an HTTP request landing in the window between "server listening" and
  // "orphan sweep done" (the server accepts connections before boot() settles
  // — see http.ts's listen()) can't spawn/resume a room's turn while a stale
  // runner from the previous daemon generation for that same room might still
  // be alive: the two would race the same transcript/runner slot. Defaults to
  // an already-resolved promise so tests/callers that skip boot() aren't stuck.
  orphanSweepDone: Promise<void> = Promise.resolve();

  constructor(private readonly options: DaemonOptions) {
    ensureAccountsFile(); // seed ~/.gaia/accounts.json so it lists as an editable settings file
  }

  get cwd(): string {
    return this.options.cwd;
  }

  log(message: string): void {
    (this.options.log ?? console.log)(`[gaia] ${message}`);
  }

  /** Boot-time sweeps. Called once the server knows its base URL. */
  async boot(baseUrl: string): Promise<void> {
    // The orphan-runner sweep must complete before anything can resume a pending
    // turn (scheduler tick, summon recovery, serviceFor from HTTP). Otherwise a
    // surviving runner from the previous daemon and the freshly resumed runner
    // can execute the same turn in parallel.
    this.orphanSweepDone = reapOrphans({ log: (message) => this.log(message) }).then(() => {});
    await this.orphanSweepDone;
    this.bridge = new HarnessBridge(baseUrl);
    const plugins = await this.pluginRegistry.stageReload();
    if (plugins.status === "failed") this.log(`plugin registry: ${plugins.reason}`);
    else await this.pluginRegistry.applyTurnBoundary();
    // Proactive runs: one tick across every initialized workspace. The first
    // tick also recovers runs a prior process left marked "running".
    this.scheduler = new SchedulerService({
      listWorkspaces: async () => (await this.registry.list()).filter((record) => record.isInitialized).map(({ id, path }) => ({ id, path })),
      serviceFor: (workspaceId, roomId) => this.serviceFor(workspaceId, roomId),
      summonHost: (workspaceId) => this.coordinatorFor(workspaceId),
      log: (message) => this.log(message),
    });
    this.scheduler.start();
    // Summon recovery: a prior process may have died with background summons
    // running or finished-but-undelivered. Re-arm each one (the child room's
    // WAL resumes its turn; the coordinator re-delivers the result to the
    // parent room) — a summon result is never silently lost.
    void this.recoverSummons();
    // Turn recovery: a prior process may have died (or been reload()ed) with a
    // room mid-turn or holding a queued-but-undrained message. Nothing else
    // wakes that room — RoomService.initOnce() resumes/drains, but only runs
    // when something calls serviceFor() for that exact room, which otherwise
    // waits for a client to reopen it. Silent and unbounded for a room nobody
    // happens to look at; see room-service.ts's own "/reload ... in-flight
    // turns resume after restart" promise, which this keeps.
    void this.recoverPendingTurns();
    await ensureVoiceSettingsFile();
    // A crash mid-call must never leave a "temporary" thinking override applied
    // forever: restore any persisted override from a dead call.
    await sweepOrphanOverrides(async (agentId, level) => {
      for (const record of await this.registry.list()) {
        try {
          const service = await this.serviceFor(record.id);
          if (service.workspace.agents[agentId]) {
            await service.setAgentThinking(agentId, level);
            return;
          }
        } catch {
          // Workspace unloadable — try the next one.
        }
      }
    }).catch(() => {});
    const cwd = resolve(this.options.cwd);
    if (existsSync(workspacePath(cwd))) await this.registry.add(cwd);
    // Account usage chip: seed from the disk cache (a restart must NEVER blank
    // it), then one probe now and a slow safety-net poll (post-turn refreshes
    // keep it live between ticks). Harness-agnostic — the service asks every
    // harness that declares usage accounts.
    await this.usageService.start();
    // Keep-awake: one-time migration off the old launchd agent, then apply the
    // persisted setting (default on) so a fresh boot starts caffeinate without
    // waiting for a settings-modal round trip. macOS-only; a no-op elsewhere.
    await migrateLegacyLaunchdAgent({ log: (message) => this.log(message) }).catch((error) =>
      this.log(`keep-awake: legacy launchd migration failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    await this.keepAwakeManager.ensure(await readKeepAwakeSetting());
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.bus.on(listener);
  }

  broadcast(event: UiEvent): void {
    this.bus.emit(event);
  }

  // --- account usage limits (account-keyed; see services/usage-service.ts) ------

  /** Complete durable native-pet seed for one workspace. It scans RoomState on
   * disk, so background/non-resident rooms are included and the shell never
   * depends on the currently selected room's snapshot. */
  async petBindings(workspaceId: string): Promise<PetBinding[]> {
    const record = await this.registry.find(workspaceId);
    return record ? listWorkspacePetBindings(workspaceId, record.path) : [];
  }

  /** Current cached usage as replayable events — used to seed a client the
   * moment it connects (SSE fan-out only carries events broadcast while it's
   * subscribed, so without this a fresh tab shows no chip until the next poll). */
  currentUsage(): Extract<UiEvent, { type: "usage-limits" }>[] {
    return this.usageService.currentUsage();
  }

  /** Current cached usage keyed by account — the manual-refresh endpoint's
   * direct response. */
  usageSnapshot(): Record<string, UsageLimits> {
    return this.usageService.snapshot();
  }

  /** Probe every declared usage account now (the manual refresh button —
   * bypasses throttle AND backoff: one human-paced attempt is what it promises). */
  async refreshUsage(): Promise<void> {
    await this.usageService.refresh({ force: true, manual: true });
  }

  scheduleUsageRefresh(): void {
    this.usageService.scheduleRefresh();
  }

  async dispose(): Promise<void> {
    this.usageService.dispose();
    this.scheduler?.dispose();
    this.interactions.dispose();
    this.keepAwakeManager.dispose();
    this.embedSidecar.dispose();
    await this.pluginRegistry.shutdown();
    const serviceDisposals = [...this.services.values()].map((service) => service.dispose());
    await Promise.all(serviceDisposals);
    this.services.clear();
    this.handedOutAt.clear();
    for (const { service: memory } of this.memoryServices.values()) memory.dispose();
    this.memoryServices.clear();
  }

  /** Typed boundary: extracted wiring receives only its declared state/actions. */
  private wiringHost(): WiringHost {
    return {
      registry: this.registry,
      pluginRegistry: this.pluginRegistry,
      orphanSweepDone: this.orphanSweepDone,
      services: this.services,
      handedOutAt: this.handedOutAt,
      servicePending: this.servicePending,
      currentRoom: this.currentRoom,
      memoryStores: this.memoryStores,
      memoryServices: this.memoryServices,
      summonCoordinators: this.summonCoordinators,
      embedSidecar: this.embedSidecar,
      bridge: this.bridge,
      scheduler: this.scheduler,
      log: (message) => this.log(message),
      broadcast: (event) => this.broadcast(event),
      scheduleUsageRefresh: () => this.scheduleUsageRefresh(),
      applyThinking: (workspaceId, roomId, agentId, level) => this.applyThinking(workspaceId, roomId, agentId, level),
      applySettingsChange: (scope, workspaceId) => this.applySettingsChange(scope, workspaceId),
    };
  }
  /** Typed boundary: reload owns no daemon state beyond this contract. */
  private reloadHost(): ReloadHost {
    const daemon = this;
    return {
      services: daemon.services,
      pendingReloads: daemon.pendingReloads,
      get hintSourcesCache() { return daemon.hintSourcesCache; },
      set hintSourcesCache(value) { daemon.hintSourcesCache = value; },
      serviceFor: (workspaceId, roomId) => daemon.serviceFor(workspaceId, roomId),
      broadcast: (event) => daemon.broadcast(event),
    };
  }
  // --- room services ------------------------------------------------------------

  /** Get-or-create the long-lived service for a (workspace, room). Omitted room
   * = the workspace's current room. LRU-bumped; creating past the soft cap
   * evicts the least-recently-used idle room. */
  /** Get-or-create the long-lived service for a (workspace, room). Omitted room
   * = the workspace's current room. LRU-bumped; creating past the soft cap
   * evicts the least-recently-used idle room. Logic lives in daemon/wiring.ts
   * (A7 split) — this stays the public entry point so every existing call
   * site (`this.serviceFor(...)`, dozens across this class) is untouched. */
  async serviceFor(workspaceId: string, roomId?: string): Promise<RoomService> {
    return wireServiceFor(this.wiringHost(), workspaceId, roomId);
  }

  /** One MemoryService per workspace — see daemon/wiring.ts (A7 split). Kept as
   * a private wrapper: called from several room-operation methods below
   * (`this.memoryServiceFor(...)`), which stay in this class untouched. */
  private memoryServiceFor(workspaceId: string, workspace: Workspace, path: string): MemoryService {
    return wireMemoryServiceFor(this.wiringHost(), workspaceId, workspace, path);
  }

  /** Boot sweep: re-arm undelivered summons — see daemon/wiring.ts. */
  private async recoverSummons(): Promise<void> {
    return wireRecoverSummons(this.wiringHost());
  }

  /** Boot sweep: wake rooms with unfinished work — see daemon/wiring.ts. */
  private async recoverPendingTurns(): Promise<void> {
    return wireRecoverPendingTurns(this.wiringHost());
  }

  async coordinatorFor(workspaceId: string): Promise<SummonCoordinator> {
    return wireCoordinatorFor(this, workspaceId);
  }

  // --- workspace/room operations ---------------------------------------------------

  async keepAwake(): Promise<KeepAwakeCapability> {
    return keepAwakeCapability();
  }

  /** Toggle the setting: persist it, then apply it immediately (spawn/kill the
   * caffeinate child). No-op capability-wise off macOS, but the preference
   * still persists so it takes effect if the daemon later runs on a Mac. */
  async setKeepAwake(enabled: boolean): Promise<KeepAwakeCapability> {
    await writeKeepAwakeSetting(enabled);
    await this.keepAwakeManager.ensure(enabled);
    return this.keepAwake();
  }

  // --- your name (Global Settings ▸ General) ---------------------------------------

  /** Configured label for the human's own transcript lines ("" = unset,
   * meaning the "user" default — see services/user-name.ts). Served in
   * /api/app so the client can show it in the settings field. */
  async userName(): Promise<string> {
    return readUserNameSetting();
  }

  /** Persist the name; every subsequent turn's prompt picks it up (read fresh
   * per turn in room-service.ts — no session reload needed). */
  async setUserName(name: string): Promise<string> {
    await writeUserNameSetting(name);
    return this.userName();
  }

  // --- theme (Global Settings ▸ General) -------------------------------------------

  /** Persisted UI palette id ("" = unset → the client's own default).
   * Daemon-side so every client window opens on the same palette. */
  async theme(): Promise<string> {
    return readThemeSetting();
  }

  /** @param theme palette id; "" clears it back to unset. */
  async setTheme(theme: string): Promise<string> {
    await writeThemeSetting(theme);
    return this.theme();
  }

  // --- settings hot-reload ----------------------------------------------------------

  /** Settings files feed workspace/agent definitions cached at service
   * creation. Rebuild affected services so saves apply without a restart.
   * Logic lives in daemon/reload.ts (A7 split); Daemon keeps the state
   * (services/pendingReloads/hintSourcesCache) these delegate against, and
   * every call site below (`this.applySettingsChange`/`this.reloadService`/
   * `this.workspaceServiceKeys`) is untouched. */
  async applySettingsChange(scope: "global" | "workspace", workspaceId?: string): Promise<void> {
    return reloadApplySettingsChange(this.reloadHost(), scope, workspaceId);
  }

  private workspaceServiceKeys(workspaceId: string): string[] {
    return wireWorkspaceServiceKeys(this.reloadHost(), workspaceId);
  }

  private async reloadService(key: string): Promise<void> {
    return doReloadService(this.reloadHost(), key);
  }

  // --- harness bridge (memory writes + summon for subprocesses) ----------------------

  verifyHarnessToken(token: string | undefined): HarnessTokenClaims | null {
    return this.bridge?.verify(token) ?? null;
  }

  private harnessApiPort(): HarnessApiPort {
    return {
      registry: this.registry,
      toolProviders: this.toolProviders,
      serviceFor: (workspaceId, roomId) => this.serviceFor(workspaceId, roomId),
      memoryServiceFor: (workspaceId, workspace, path) => this.memoryServiceFor(workspaceId, workspace, path),
    };
  }

  harnessGaiaTools(workspace: Workspace, agentId: string): readonly GaiaTool[] { return harnessGaiaTools(workspace, agentId); }
  harnessToolProviders(): ToolProviders { return harnessToolProviders(this.harnessApiPort()); }
  async harnessMemoryBatch(claims: HarnessTokenClaims, file: string, operations: Array<{ action: MemoryAction; content?: string; oldText?: string }>): Promise<MemoryMutationResult> { return harnessMemoryBatch(this.harnessApiPort(), claims, file, operations); }
  async harnessMemoryWrite(claims: HarnessTokenClaims, file: string, action: MemoryAction, options: { content?: string; oldText?: string }): Promise<MemoryMutationResult> { return harnessMemoryWrite(this.harnessApiPort(), claims, file, action, options); }
  /** Chat-wide transcript search for the web client. Transcript-only and
   * navigable to the matched message. No `workspaceId` scans every initialized
   * workspace; `roomId` narrows to a single chat (in-chat search). Bm25 order
   * within a workspace; the cross-workspace merge sorts by score (independent
   * indexes, so approximate) and caps the merged list. */
  async searchChats(query: string, options: { workspaceId?: string; roomId?: string; limit?: number } = {}): Promise<ChatSearchResult> {
    const trimmed = query.trim();
    if (!trimmed) return { hits: [], degraded: [] };
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 40;
    const records = options.workspaceId
      ? [await this.registry.find(options.workspaceId)].filter((record): record is WorkspaceRecord => Boolean(record))
      : (await this.registry.list()).filter((record) => record.isInitialized);
    const hits: ChatSearchHit[] = [];
    const degraded: string[] = [];
    for (const record of records) {
      try {
        const service = await this.serviceFor(record.id);
        const memory = this.memoryServiceFor(record.id, service.workspace, record.path);
        const found = await memory.searchChats(trimmed, { ...(options.roomId ? { roomId: options.roomId } : {}), limit });
        for (const note of found.degraded) degraded.push(`${record.name}: ${note}`);
        if (!found.hits.length) continue;
        // Resolve titles once per workspace (only for workspaces with hits).
        const titles = new Map<string, string>();
        for (const room of await service.listRooms()) if (room.title) titles.set(room.id, room.title);
        for (const hit of found.hits) {
          const title = titles.get(hit.roomId);
          hits.push({
            workspaceId: record.id,
            workspaceName: record.name,
            roomId: hit.roomId,
            ...(title ? { roomTitle: title } : {}),
            eventId: hit.eventIds[0] ?? "",
            eventIds: hit.eventIds,
            snippet: hit.snippet,
            ts: hit.ts,
            speakers: hit.speakers,
            score: hit.score,
          });
        }
      } catch (error) {
        degraded.push(`${record.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, limit), degraded };
  }

  async harnessRecall(claims: HarnessTokenClaims, query: string, limit?: number, options: { summarize?: boolean } = {}): Promise<{ result: string; hits: MemorySearchHit[] }> { return harnessRecall(this.harnessApiPort(), claims, query, limit, options); }
  async harnessRecallScroll(claims: HarnessTokenClaims, hitId: number, options: { span?: number; offset?: number } = {}): Promise<string> { return harnessRecallScroll(this.harnessApiPort(), claims, hitId, options); }
  async harnessToolResultFetch(claims: HarnessTokenClaims, sessionId: string, entryId: string, offset: number, limit: number): Promise<{ text: string; totalLength: number; hasMore: boolean }> { return harnessToolResultFetch(this.harnessApiPort(), claims, sessionId, entryId, offset, limit); }
  async harnessContextDietGet(claims: HarnessTokenClaims): Promise<ContextDietView> { return harnessContextDietGet(this.harnessApiPort(), claims); }
  async harnessContextDietSet(claims: HarnessTokenClaims, scope: "room" | "workspace", patch: ContextDietOverrides): Promise<ContextDietView> { return harnessContextDietSet(this.harnessApiPort(), claims, scope, patch); }
  async harnessEndConversation(claims: HarnessTokenClaims, farewell: string): Promise<string> { return harnessEndConversation(this.harnessApiPort(), claims, farewell); }
  async harnessDogCommand(claims: HarnessTokenClaims, sub: "on" | "off" | "status"): Promise<string> { return harnessDogCommand(this.harnessApiPort(), claims, sub); }
  async harnessGhoulRoomRead(claims: HarnessTokenClaims, targetRoomId: string, options: { offset?: number; limit?: number } = {}): Promise<string> { return harnessGhoulRoomRead(this.harnessApiPort(), claims, targetRoomId, options); }
  async harnessGhoulLedgerSearch(claims: HarnessTokenClaims, query?: string): Promise<string> { return harnessGhoulLedgerSearch(this.harnessApiPort(), claims, query); }
  async harnessDreamPropose(claims: HarnessTokenClaims, agentId: string): Promise<string> { return harnessDreamPropose(this.harnessApiPort(), claims, agentId); }
  async harnessDreamApply(claims: HarnessTokenClaims, agentId: string): Promise<string> { return harnessDreamApply(this.harnessApiPort(), claims, agentId); }

  /** Memory health rows for `gaia memory status` and the web status surface. */
  async memoryHealth(workspaceId: string): Promise<MemoryHealthRow[]> {
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    const workspace = await loadWorkspace(record.path);
    return this.memoryServiceFor(workspaceId, workspace, record.path).health();
  }

  async resolveProxyUpstream(claims: HarnessTokenClaims): Promise<UpstreamCredential | undefined> {
    let agent: AgentDef | undefined;
    try {
      const service = await this.serviceFor(claims.workspaceId, claims.roomId);
      agent = service.workspace.agents[claims.agentId];
    } catch {
      agent = undefined;
    }
    return agent ? resolveUpstreamCredential(agent) : undefined;
  }

  // --- thinking (call-scoped vs persistent) --------------------------------------------

  async fileHints(file: EditableFileContent, workspaceId?: string): Promise<FileHints | undefined> {
    if (file.kind !== "json") return undefined;

    let agentIds: string[] = [];
    let roomIds: string[] = [];
    let skillWorkspace: { dir: string } = { dir: this.options.cwd };
    if (workspaceId) {
      try {
        const service = await this.serviceFor(workspaceId);
        agentIds = Object.keys(service.workspace.agents);
        roomIds = (await service.listRooms()).map((room) => room.id);
        skillWorkspace = service.workspace;
      } catch {
        // Hints degrade gracefully when the workspace cannot be loaded.
      }
    }

    this.hintSourcesCache ??= { toolNames: sdkToolNames(this.options.cwd), models: (await readModelCatalog()).models };
    const sources: HintSources = {
      agentIds,
      roomIds,
      toolNames: this.hintSourcesCache.toolNames,
      thinkingLevels: sdkThinkingLevels(),
      models: this.hintSourcesCache.models,
      skills: skillHintOptions(skillWorkspace),
    };
    return buildFileHints({ label: file.label, kind: file.kind, content: file.content }, sources);
  }

  /** Sync, resident-only workspace lookup for one {workspaceId, roomId} —
   * the capability broker's grantSource/trustSource (see the pluginRegistry
   * field above) are sync by contract and must never do I/O, so this reads
   * ONLY an already-loaded RoomService's cached Workspace off `this.services`
   * (keyed by daemon/wiring.js#serviceKey) and returns undefined otherwise —
   * unlike the async `workspaceForId` below, it never falls back to disk. */
  #liveWorkspaceFor(workspaceId: string, roomId: string): Workspace | undefined {
    return this.services.get(serviceKey(workspaceId, roomId))?.workspace;
  }

  async workspaceForId(workspaceId: string): Promise<Workspace | undefined> {
    const key = this.workspaceServiceKeys(workspaceId)[0];
    const service = key ? this.services.get(key) : undefined;
    if (service) return service.workspace;
    const record = await this.registry.find(workspaceId);
    if (!record?.isInitialized) return undefined;
    return loadWorkspace(record.path);
  }

  // --- app payload -----------------------------------------------------------------------

  async appPayload(currentWorkspaceId?: string, humanId?: string): Promise<{
    workspaces: WorkspaceRecord[];
    currentWorkspaceId: string | undefined;
    globalFiles: EditableFileDescriptor[];
    snapshot: Snapshot | undefined;
    workspaceFiles: EditableFileDescriptor[];
    voice: VoiceCallInfo | null;
    workspaceRooms: Record<string, Snapshot["rooms"]>;
    keepAwake: KeepAwakeCapability;
    userName: string;
    theme: string;
  }> {
    const workspaces = await this.registry.listForHuman(humanId);
    const current = currentWorkspaceId ?? workspaces.find((workspace) => workspace.isInitialized)?.id;
    // Seed the sidebar's workspace-level running/unread dots: a disk-only room
    // scan per initialized workspace (no live services spun up), kept fresh
    // afterwards by the same cross-workspace `rooms` broadcasts. A scan failure
    // for one workspace never sinks the whole payload.
    const workspaceRooms: Record<string, Snapshot["rooms"]> = {};
    await Promise.all(
      workspaces
        .filter((workspace) => workspace.isInitialized)
        .map(async (workspace) => {
          try {
            workspaceRooms[workspace.id] = await scanRoomActivity(workspace.path);
          } catch {
            workspaceRooms[workspace.id] = [];
          }
        }),
    );
    return {
      workspaces,
      currentWorkspaceId: current,
      globalFiles: await this.files.listGlobal(),
      snapshot: current ? await (await this.serviceFor(current)).getSnapshot() : undefined,
      workspaceFiles: current ? await this.files.listWorkspace(current) : [],
      voice: this.voiceFor(current),
      workspaceRooms,
      keepAwake: await this.keepAwake(),
      userName: await this.userName(),
      theme: await this.theme(),
    };
  }
  private readonly interactions = new RoomInteractionLifecycle(this.interactionHost());
  get activeCall() { return this.interactions.activeCall; }
  private interactionHost(): RoomInteractionHost {
    return {
      registry: this.registry, files: this.files, currentRoom: this.currentRoom, services: this.services,
      memoryServices: this.memoryServices, memoryStores: this.memoryStores, summonCoordinators: this.summonCoordinators,
      log: (message) => this.log(message), broadcast: (event) => this.broadcast(event),
      serviceFor: (workspaceId, roomId) => this.serviceFor(workspaceId, roomId),
      memoryServiceFor: (workspaceId, workspace, path) => this.memoryServiceFor(workspaceId, workspace, path),
      petBindings: (workspaceId) => this.petBindings(workspaceId),
      workspaceServiceKeys: (workspaceId) => this.workspaceServiceKeys(workspaceId),
      reloadService: (key) => this.reloadService(key),
      appPayload: (workspaceId, humanId) => this.appPayload(workspaceId, humanId),
    };
  }
  async addWorkspace(...args: Parameters<RoomInteractionLifecycle["addWorkspace"]>) { return this.interactions.addWorkspace(...args); }
  async setWorkspaceFavorite(...args: Parameters<RoomInteractionLifecycle["setWorkspaceFavorite"]>) { return this.interactions.setWorkspaceFavorite(...args); }
  async reorderWorkspaces(...args: Parameters<RoomInteractionLifecycle["reorderWorkspaces"]>) { return this.interactions.reorderWorkspaces(...args); }
  async selectRoom(...args: Parameters<RoomInteractionLifecycle["selectRoom"]>) { return this.interactions.selectRoom(...args); }
  async renameRoom(...args: Parameters<RoomInteractionLifecycle["renameRoom"]>) { return this.interactions.renameRoom(...args); }
  async setRoomFavorite(...args: Parameters<RoomInteractionLifecycle["setRoomFavorite"]>) { return this.interactions.setRoomFavorite(...args); }
  async deleteRoom(...args: Parameters<RoomInteractionLifecycle["deleteRoom"]>) { return this.interactions.deleteRoom(...args); }
  async deleteWorkspace(...args: Parameters<RoomInteractionLifecycle["deleteWorkspace"]>) { return this.interactions.deleteWorkspace(...args); }
  async setAgentRole(...args: Parameters<RoomInteractionLifecycle["setAgentRole"]>) { return this.interactions.setAgentRole(...args); }
  async setAgentDefaultRole(...args: Parameters<RoomInteractionLifecycle["setAgentDefaultRole"]>) { return this.interactions.setAgentDefaultRole(...args); }
  async runPluginAction(...args: Parameters<RoomInteractionLifecycle["runPluginAction"]>) { return this.interactions.runPluginAction(...args); }
  async setRoomAgentDialogue(...args: Parameters<RoomInteractionLifecycle["setRoomAgentDialogue"]>) { return this.interactions.setRoomAgentDialogue(...args); }
  async setDefaultAgent(...args: Parameters<RoomInteractionLifecycle["setDefaultAgent"]>) { return this.interactions.setDefaultAgent(...args); }
  async deleteAgent(...args: Parameters<RoomInteractionLifecycle["deleteAgent"]>) { return this.interactions.deleteAgent(...args); }
  async applyThinking(...args: Parameters<RoomInteractionLifecycle["applyThinking"]>) { return this.interactions.applyThinking(...args); }
  voiceFor(...args: Parameters<RoomInteractionLifecycle["voiceFor"]>) { return this.interactions.voiceFor(...args); }
  async startVoiceCall(...args: Parameters<RoomInteractionLifecycle["startVoiceCall"]>) { return this.interactions.startVoiceCall(...args); }
  async stopVoiceCall(...args: Parameters<RoomInteractionLifecycle["stopVoiceCall"]>) { return this.interactions.stopVoiceCall(...args); }
  classifyTurn(...args: Parameters<RoomInteractionLifecycle["classifyTurn"]>) { return this.interactions.classifyTurn(...args); }
  async resolveContextGate(...args: Parameters<RoomInteractionLifecycle["resolveContextGate"]>) { return this.interactions.resolveContextGate(...args); }
  async readAloud(...args: Parameters<RoomInteractionLifecycle["readAloud"]>) { return this.interactions.readAloud(...args); }
  async readAloudStream(...args: Parameters<RoomInteractionLifecycle["readAloudStream"]>) { return this.interactions.readAloudStream(...args); }
  async transcribe(...args: Parameters<RoomInteractionLifecycle["transcribe"]>) { return this.interactions.transcribe(...args); }
}
