// The composition root. Owns every cross-room, cross-workspace concern the v1
// server buried inside HTTP handlers: workspace registry, per-room services
// (LRU, busy-aware), per-workspace memory stores + summon coordinators, the
// harness bridge, the voice call session, thinking scoping, settings
// hot-reload, and the UI event bus. The HTTP server (server/http.ts) is a pure
// route table over this class.

import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Bus } from "./core/bus.js";
import { DEFAULTS } from "./core/config.js";
import { gaiaHome, globalPaths, workspacePaths } from "./core/paths.js";
import { readJson, writeJsonAtomic } from "./core/store.js";
import type { AgentDef, ChatSearchHit, ChatSearchResult, Snapshot, UiEvent, UsageLimits, VoiceCallInfo, Workspace } from "./core/types.js";
import { capabilitiesFor, type GaiaTool, usageProbes } from "./harness/spec.js";
import { reapOrphans } from "./harness/reaper.js";
import type { MemoryAction, MemoryMutationResult } from "./domain/memory.js";
import { MemoryStore } from "./domain/memory.js";
import { DEFAULT_ROOM, ensureWorkspaceRoom, initWorkspace, isValidRoomId, loadWorkspace, setWorkspaceDefaultAgent, setWorkspaceRoom, trashWorkspaceRoom, workspacePath } from "./domain/workspace.js";
import { RoomService } from "./services/room-service.js";
import { MemoryService } from "./services/memory-service.js";
import { EmbedSidecar } from "./services/embed-sidecar.js";
import { SchedulerService } from "./services/scheduler.js";
import type { ConsolidateLlm } from "./services/consolidate.js";
import { formatMemoryHits, scrollTranscriptWindow, workspaceRoomRefs, type MemoryHealthRow, type MemorySearchHit, type RoomRef } from "./domain/workspace-index.js";
import { SummonCoordinator } from "./services/summons.js";
import { HarnessBridge, type HarnessTokenClaims } from "./services/bridge.js";
import { resolveUpstreamCredential, type UpstreamCredential } from "./services/proxy.js";
import { EditableFileRegistry, buildFileHints, readModelCatalog, sdkThinkingLevels, sdkToolNames, skillHintOptions, type EditableFileContent, type EditableFileDescriptor, type FileHints, type HintSources, type ModelChoice } from "./services/hints.js";
import {
  VoiceStackManager,
  classifyVoiceTurn,
  clearCallOverride,
  ensureVoiceSettingsFile,
  persistCallOverride,
  readVoiceSettings,
  sweepOrphanOverrides,
  type VoiceSettings,
} from "./services/voice.js";
import { readAloud, readAloudStream, resolveTtsChoice, ttsStackSettings, type ReadAloudDelivery, type ReadAloudResult } from "./services/read-aloud.js";
import { transcribe, type SttAudioInput } from "./services/transcribe.js";
import { TtsCallBridge } from "./services/voice-tts-bridge.js";

// --- workspace registry (recent workspaces in ~/.gaia/app.json) ----------------

export interface WorkspaceRecord {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: string;
  isInitialized: boolean;
}

function pathId(path: string, length: number): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, length);
}

function normalizeRecord(path: string, lastOpenedAt = new Date().toISOString()): WorkspaceRecord {
  const resolved = resolve(path);
  const parts = resolved.split(/[\\/]/).filter(Boolean);
  return {
    id: pathId(resolved, 16),
    path: resolved,
    name: parts[parts.length - 1] ?? resolved,
    lastOpenedAt,
    isInitialized: existsSync(workspacePath(resolved)),
  };
}

export class WorkspaceRegistry {
  constructor(private readonly configPath = `${gaiaHome()}/app.json`) {}

  async list(): Promise<WorkspaceRecord[]> {
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    return (config.recentWorkspaces ?? [])
      .map((record) => normalizeRecord(record.path, record.lastOpenedAt))
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async add(path: string): Promise<WorkspaceRecord> {
    const record = normalizeRecord(path);
    const config = ((await readJson(this.configPath)) ?? {}) as { recentWorkspaces?: WorkspaceRecord[] };
    const next = [record, ...(config.recentWorkspaces ?? []).filter((item) => item.id !== record.id)].slice(0, 30);
    await writeJsonAtomic(this.configPath, { ...config, recentWorkspaces: next });
    return record;
  }

  async find(id: string): Promise<WorkspaceRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }
}

// --- the daemon -----------------------------------------------------------------

/** Soft cap on simultaneously-resident room services. Idle rooms past this are
 * evicted (transcripts persist on disk); busy ones are always kept. */
const MAX_LIVE_SERVICES = 32;

function serviceKey(workspaceId: string, roomId: string): string {
  return `${workspaceId}::${roomId}`;
}

export interface DaemonOptions {
  cwd: string;
  log?: (message: string) => void;
}

// Usage limits change slowly (only your own turns spend, and windows reset on
// their own clock the client counts down locally) — so the interval is just a
// safety net for reset rollovers; the real freshness comes from the post-turn
// debounced refresh.
const USAGE_POLL_MS = 5 * 60_000;
const USAGE_REFRESH_DEBOUNCE_MS = 4000;

/** True when two usage snapshots differ in anything the UI shows (ignoring the
 * ever-changing fetchedAt stamp) — gates a redundant broadcast. */
function usageChanged(a: UsageLimits | null | undefined, b: UsageLimits | null): boolean {
  if (!a || !b) return (a ?? null) !== (b ?? null);
  const strip = (u: UsageLimits) => JSON.stringify({ plan: u.plan, windows: u.windows });
  return strip(a) !== strip(b);
}

export interface SelectionPayload {
  snapshot: Snapshot;
  workspaceFiles: EditableFileDescriptor[];
  voice: VoiceCallInfo | null;
}

export class Daemon {
  readonly registry = new WorkspaceRegistry();
  readonly files = new EditableFileRegistry((id) => this.workspaceForId(id));
  readonly voiceStack = new VoiceStackManager(globalPaths.voiceLogsDir());
  private readonly services = new Map<string, RoomService>();
  private readonly currentRoom = new Map<string, string>();
  private readonly memoryStores = new Map<string, MemoryStore>();
  private readonly memoryServices = new Map<string, { service: MemoryService; live: { workspace: Workspace } }>();
  /** One local embedding sidecar per daemon (model server shared across
   * workspaces); MemoryService reaches it through EmbedderDeps. Download and
   * startup progress fans out to every workspace's health table — a 300MB
   * model pull must be visible, not a buried log line (§10). */
  private readonly embedSidecar = new EmbedSidecar({
    log: (message) => this.log(message),
    onProgress: (state, detail, role) => {
      for (const { service } of this.memoryServices.values()) service.noteSidecarProgress(role === "rerank" ? "reranker" : "embedder", state, detail);
    },
  });
  private readonly summonCoordinators = new Map<string, SummonCoordinator>();
  private readonly bus = new Bus<UiEvent>();
  private readonly pendingReloads = new Set<string>();
  /** Latest account usage per harness (subscription session/weekly caps), cached
   * so a newly-connected client can be seeded immediately (see currentUsage).
   * Refreshed on a slow timer + after each turn; harness-agnostic. */
  private readonly usage = new Map<string, UsageLimits>();
  private usagePollTimer: ReturnType<typeof setInterval> | undefined;
  private usageRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private usageRefreshing = false;
  private hintSourcesCache: { toolNames: string[]; models: ModelChoice[] } | undefined;
  private bridge: HarnessBridge | undefined;
  private scheduler: SchedulerService | undefined;
  /** One voice call at a time; unmute's chat-completions requests bind to it. */
  activeCall: { workspaceId: string; info: VoiceCallInfo; settings: VoiceSettings } | undefined;
  voiceStarting = false;
  // Live only while a call routes its TTS through a read-aloud engine
  // (claude-voice); torn down on hang-up.
  private ttsBridge: TtsCallBridge | undefined;

  constructor(private readonly options: DaemonOptions) {}

  get cwd(): string {
    return this.options.cwd;
  }

  private log(message: string): void {
    (this.options.log ?? console.log)(`[gaia] ${message}`);
  }

  /** Boot-time sweeps. Called once the server knows its base URL. */
  async boot(baseUrl: string): Promise<void> {
    this.bridge = new HarnessBridge(baseUrl);
    // Proactive runs: one tick across every initialized workspace. The first
    // tick also recovers runs a prior process left marked "running".
    this.scheduler = new SchedulerService({
      listWorkspaces: async () => (await this.registry.list()).filter((record) => record.isInitialized).map(({ id, path }) => ({ id, path })),
      serviceFor: (workspaceId, roomId) => this.serviceFor(workspaceId, roomId),
      summonHost: (workspaceId) => this.coordinatorFor(workspaceId),
      log: (message) => this.log(message),
    });
    this.scheduler.start();
    reapOrphans({ log: (message) => this.log(message) });
    // Summon recovery: a prior process may have died with background summons
    // running or finished-but-undelivered. Re-arm each one (the child room's
    // WAL resumes its turn; the coordinator re-delivers the result to the
    // parent room) — a summon result is never silently lost.
    void this.recoverSummons();
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
    // Account usage chip: one probe now, then a slow safety-net poll (post-turn
    // refreshes keep it live between ticks). Harness-agnostic — refreshUsage
    // asks every harness that declares a probe.
    void this.refreshUsage();
    this.usagePollTimer = setInterval(() => void this.refreshUsage(), USAGE_POLL_MS);
    this.usagePollTimer.unref?.();
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.bus.on(listener);
  }

  broadcast(event: UiEvent): void {
    this.bus.emit(event);
  }

  // --- account usage limits (harness-agnostic) ----------------------------------

  /** Current cached usage as replayable events — used to seed a client the
   * moment it connects (SSE fan-out only carries events broadcast while it's
   * subscribed, so without this a fresh tab shows no chip until the next poll). */
  currentUsage(): Extract<UiEvent, { type: "usage-limits" }>[] {
    return [...this.usage.entries()].map(([harness, usage]) => ({ type: "usage-limits", harness, usage }));
  }

  /** Poll every harness that declares a usage probe (RULE #0: no harness-id
   * branch — each declares its own probe as data on its spec) and broadcast any
   * change. Fail-soft: a probe that throws or returns null clears that chip. */
  async refreshUsage(): Promise<void> {
    if (this.usageRefreshing) return;
    this.usageRefreshing = true;
    try {
      await Promise.all(
        usageProbes().map(async ({ harness, probe }) => {
          let usage: UsageLimits | null = null;
          try {
            usage = await probe();
          } catch {
            usage = null;
          }
          const prev = this.usage.get(harness);
          if (usage) this.usage.set(harness, usage);
          else this.usage.delete(harness);
          // Skip a redundant broadcast when nothing meaningful changed (the
          // fetchedAt stamp always differs, so compare the payload sans it).
          if (usageChanged(prev, usage)) this.broadcast({ type: "usage-limits", harness, usage });
        }),
      );
    } finally {
      this.usageRefreshing = false;
    }
  }

  /** Debounced usage refresh — a turn's token spend lands a few seconds after it
   * ends, and rapid multi-agent turns coalesce into one probe. */
  private scheduleUsageRefresh(): void {
    if (this.usageRefreshTimer) return;
    this.usageRefreshTimer = setTimeout(() => {
      this.usageRefreshTimer = undefined;
      void this.refreshUsage();
    }, USAGE_REFRESH_DEBOUNCE_MS);
    this.usageRefreshTimer.unref?.();
  }

  dispose(): void {
    if (this.usagePollTimer) clearInterval(this.usagePollTimer);
    if (this.usageRefreshTimer) clearTimeout(this.usageRefreshTimer);
    this.scheduler?.dispose();
    this.ttsBridge?.stop();
    this.voiceStack.stop();
    this.embedSidecar.dispose();
    for (const service of this.services.values()) service.dispose();
    this.services.clear();
    for (const { service: memory } of this.memoryServices.values()) memory.dispose();
    this.memoryServices.clear();
  }

  // --- room services ------------------------------------------------------------

  /** Get-or-create the long-lived service for a (workspace, room). Omitted room
   * = the workspace's current room. LRU-bumped; creating past the soft cap
   * evicts the least-recently-used idle room. */
  async serviceFor(workspaceId: string, roomId?: string): Promise<RoomService> {
    const resolvedRoom = roomId ?? (await this.resolveCurrentRoom(workspaceId));
    const key = serviceKey(workspaceId, resolvedRoom);

    const existing = this.services.get(key);
    if (existing) {
      this.services.delete(key);
      this.services.set(key, existing);
      return existing;
    }

    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    await ensureWorkspaceRoom(record.path, resolvedRoom);
    const workspace = await loadWorkspace(record.path);
    const service = await RoomService.open({
      workspaceId,
      workspace,
      roomId: resolvedRoom,
      memoryStore: this.memoryStoreFor(workspaceId),
      memory: this.memoryServiceFor(workspaceId, workspace, record.path),
      // Same LLM caller consolidation uses — backs the context-gate compact.
      llm: consolidateLlm(),
      summonHost: this.summonCoordinatorFor(workspaceId, workspace, record.path),
      setThinking: async (agentId, level) => (await this.applyThinking(workspaceId, agentId, level)).message,
      // Same reload the settings-file save route uses: /model + /thinking
      // rewrite agent.json, and only a service rebuild reaches the runner
      // subprocesses (they snapshot the config at spawn).
      settingsChanged: (scope) => this.applySettingsChange(scope, workspaceId),
      harnessHost: this.bridge ? (opts) => this.bridge!.hostFor(workspaceId, opts) : undefined,
      // Closures resolve this.scheduler per call: services built before boot()
      // (or after dispose) answer gracefully instead of binding a stale ref.
      scheduler: {
        list: () => this.scheduler?.describeWorkspace(workspaceId, record.path) ?? Promise.resolve("The scheduler is not running."),
        runNow: (jobId) => this.scheduler?.runNow(workspaceId, record.path, jobId) ?? Promise.resolve("The scheduler is not running."),
      },
    });
    service.subscribe((event) => {
      this.broadcast(event);
      // A finished turn just spent tokens — refresh the account usage chip so it
      // tracks live instead of waiting for the slow poll.
      if (event.type === "task-end" || event.type === "task-error") this.scheduleUsageRefresh();
    });
    await service.init();
    this.services.set(key, service);
    this.evictIdleServices();
    return service;
  }

  private async resolveCurrentRoom(workspaceId: string): Promise<string> {
    const cached = this.currentRoom.get(workspaceId);
    if (cached) return cached;
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    const workspace = await loadWorkspace(record.path);
    this.currentRoom.set(workspaceId, workspace.config.room);
    return workspace.config.room;
  }

  private evictIdleServices(): void {
    for (const [key, service] of this.services) {
      if (this.services.size <= MAX_LIVE_SERVICES) break;
      if (service.isBusy) continue;
      service.dispose();
      this.services.delete(key);
      this.log(`evicted idle room service ${key} (soft cap ${MAX_LIVE_SERVICES})`);
    }
  }

  private memoryStoreFor(workspaceId: string): MemoryStore {
    let store = this.memoryStores.get(workspaceId);
    if (!store) {
      store = new MemoryStore();
      this.memoryStores.set(workspaceId, store);
    }
    return store;
  }

  /** One MemoryService per workspace. Holds live workspace accessors so a
   * settings reload changes behavior without a rebuild; the consolidation LLM
   * runs daemon-side through the same credential store as the proxy. */
  private memoryServiceFor(workspaceId: string, workspace: Workspace, path: string): MemoryService {
    const existing = this.memoryServices.get(workspaceId);
    if (existing) {
      // Workspace objects are rebuilt on settings reload; the accessors close
      // over `live`, so refreshing it here keeps the memory service current.
      existing.live.workspace = workspace;
      return existing.service;
    }
    const live = { workspace };
    const service = new MemoryService({
      workspaceRoot: path,
      workspaceMemory: () => live.workspace.config.memory,
      agents: () => live.workspace.agents,
      memoryStore: this.memoryStoreFor(workspaceId),
      roomsFor: () => this.recentRoomRefs(path),
      llm: consolidateLlm(),
      log: (message) => this.log(message),
      embedderDeps: {
        ensureLocalSidecar: (modelId) => this.embedSidecar.ensure(modelId),
        ensureLocalReranker: (modelId) => this.embedSidecar.ensureRerank(modelId),
      },
    });
    this.memoryServices.set(workspaceId, { service, live });
    return service;
  }

  /** Every room transcript in the workspace, most-recently-active first, for
   * the workspace memory index (one shared definition: workspaceRoomRefs). */
  private recentRoomRefs(workspaceRoot: string): RoomRef[] {
    return workspaceRoomRefs(workspaceRoot);
  }

  private summonCoordinatorFor(workspaceId: string, workspace: Workspace, path: string): SummonCoordinator {
    let coordinator = this.summonCoordinators.get(workspaceId);
    if (!coordinator) {
      coordinator = new SummonCoordinator(
        workspace,
        path,
        (roomId) => this.serviceFor(workspaceId, roomId),
        workspace.config.maxSummonsPerRoom ?? DEFAULTS.maxSummonsPerRoom,
        (message) => this.log(message),
      );
      this.summonCoordinators.set(workspaceId, coordinator);
    }
    return coordinator;
  }

  /** Boot sweep: re-arm undelivered summons in every initialized workspace
   * (see SummonCoordinator.recoverUndelivered). Failures are logged, never
   * thrown — recovery must not take the daemon down. */
  private async recoverSummons(): Promise<void> {
    for (const record of await this.registry.list()) {
      if (!record.isInitialized) continue;
      try {
        await (await this.coordinatorFor(record.id)).recoverUndelivered();
      } catch (error) {
        this.log(`summon recovery skipped for workspace ${record.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async coordinatorFor(workspaceId: string): Promise<SummonCoordinator> {
    const existing = this.summonCoordinators.get(workspaceId);
    if (existing) return existing;
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    const workspace = await loadWorkspace(record.path);
    return this.summonCoordinatorFor(workspaceId, workspace, record.path);
  }

  // --- workspace/room operations ---------------------------------------------------

  async addWorkspace(path: string): Promise<WorkspaceRecord> {
    let record = await this.registry.add(path);
    if (!record.isInitialized) {
      // Adding through the UI is an explicit "make this a GAIA workspace".
      await initWorkspace(record.path);
      record = await this.registry.add(record.path);
    }
    await this.serviceFor(record.id);
    return record;
  }

  async selectRoom(workspaceId: string, roomId: string): Promise<SelectionPayload> {
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);

    // Each room keeps its own long-lived service, so switching is always safe;
    // only a live voice call (bound to one room) blocks it.
    if (this.activeCall?.workspaceId === workspaceId && this.activeCall.info.roomId !== roomId) {
      throw new Error("Stop the active voice call before switching rooms.");
    }

    await ensureWorkspaceRoom(record.path, roomId);
    await setWorkspaceRoom(record.path, roomId);
    this.currentRoom.set(workspaceId, roomId);

    const service = await this.serviceFor(workspaceId, roomId);
    const snapshot = await service.getSnapshot();
    this.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  private roomIdsOnDisk(workspaceRoot: string): string[] {
    const dir = workspacePaths.roomsDir(workspaceRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  /** Delete a room: dispose its live service, move its directory to the
   * workspace trash (reversible — never rm -rf), purge it from memory (index
   * rows + every agent's episodes), and reselect a neighbour so a room is always
   * in view. Refuses to delete a voice-call room or the last room. */
  async deleteRoom(workspaceId: string, roomId: string): Promise<SelectionPayload> {
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (!isValidRoomId(roomId)) throw new Error("Invalid room id.");
    if (this.activeCall?.workspaceId === workspaceId && this.activeCall.info.roomId === roomId) {
      throw new Error("Stop the active voice call before deleting this room.");
    }

    const roomIds = this.roomIdsOnDisk(record.path);
    if (!roomIds.includes(roomId)) throw new Error(`Room not found: ${roomId}`);
    if (roomIds.length <= 1) throw new Error("Can't delete the only room in the workspace.");

    // Stop any in-flight turn before pulling the room out from under the WAL
    // writer, then drop the live service so nothing writes the doomed dir.
    const key = serviceKey(workspaceId, roomId);
    const service = this.services.get(key);
    if (service) {
      if (service.isBusy) await service.cancelActiveTask();
      service.dispose();
      this.services.delete(key);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trash = await trashWorkspaceRoom(record.path, roomId, stamp);
    const workspace = await loadWorkspace(record.path);
    const episodesPurged = await this.memoryServiceFor(workspaceId, workspace, record.path).purgeRoom(roomId, trash || undefined);
    this.log(`deleted room ${roomId} (ws ${workspaceId}) → trash ${trash || "(already gone)"}; purged ${episodesPurged} episode(s) from memory`);

    // Reselect a neighbour if the deleted room was current (or nothing is).
    const current = this.currentRoom.get(workspaceId);
    const next = current && current !== roomId ? current : (roomIds.find((id) => id !== roomId) ?? DEFAULT_ROOM);
    await setWorkspaceRoom(record.path, next);
    this.currentRoom.set(workspaceId, next);

    const nextService = await this.serviceFor(workspaceId, next);
    const snapshot = await nextService.getSnapshot();
    this.broadcast({ type: "rooms", workspaceId, rooms: await nextService.listRooms() });
    this.broadcast({ type: "snapshot", workspaceId, roomId: nextService.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  async setAgentRole(workspaceId: string, roomId: string, agentId: string, role: string): Promise<SelectionPayload & { message: string }> {
    const service = await this.serviceFor(workspaceId, roomId);
    const message = await service.setRole(agentId, role);
    const snapshot = await service.getSnapshot();
    this.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId), message };
  }

  /** Toggle room agent-dialogue (agents replying to each other's @mentions). */
  async setRoomAgentDialogue(workspaceId: string, roomId: string, on: boolean): Promise<SelectionPayload> {
    const service = await this.serviceFor(workspaceId, roomId);
    await service.setAgentDialogue(on);
    const snapshot = await service.getSnapshot();
    this.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  async setDefaultAgent(workspaceId: string, agentId: string): Promise<SelectionPayload> {
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);

    const service = await this.serviceFor(workspaceId);
    if (!service.workspace.agents[agentId]) throw new Error(`Unknown agent: @${agentId}`);
    await setWorkspaceDefaultAgent(record.path, agentId);

    // The default is workspace-wide: rebuild every resident room service.
    await Promise.all(this.workspaceServiceKeys(workspaceId).map((key) => this.reloadService(key)));
    const rebuilt = await this.serviceFor(workspaceId);
    const snapshot = await rebuilt.getSnapshot();
    this.broadcast({ type: "snapshot", workspaceId, roomId: rebuilt.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  // --- settings hot-reload ----------------------------------------------------------

  /** Settings files feed workspace/agent definitions cached at service
   * creation. Rebuild affected services so saves apply without a restart. */
  async applySettingsChange(scope: "global" | "workspace", workspaceId?: string): Promise<void> {
    this.hintSourcesCache = undefined;
    const keys = scope === "global" ? [...this.services.keys()] : workspaceId ? this.workspaceServiceKeys(workspaceId) : [];
    await Promise.all(keys.map((key) => this.reloadService(key)));
  }

  private workspaceServiceKeys(workspaceId: string): string[] {
    const prefix = serviceKey(workspaceId, "");
    return [...this.services.keys()].filter((key) => key.startsWith(prefix));
  }

  private async reloadService(key: string): Promise<void> {
    const service = this.services.get(key);
    if (!service) return;

    if (service.hasActiveTask) {
      // Deferred while a turn runs; re-attempted when it settles.
      if (this.pendingReloads.has(key)) return;
      this.pendingReloads.add(key);
      void service
        .waitForIdle()
        .then(() => {
          this.pendingReloads.delete(key);
          return this.reloadService(key);
        })
        .catch(() => this.pendingReloads.delete(key));
      return;
    }

    const { workspaceId, roomId } = service;
    service.dispose();
    this.services.delete(key);
    const fresh = await this.serviceFor(workspaceId, roomId);
    this.broadcast({ type: "snapshot", workspaceId, roomId: fresh.roomId, snapshot: await fresh.getSnapshot() });
  }

  // --- harness bridge (memory writes + summon for subprocesses) ----------------------

  verifyHarnessToken(token: string | undefined): HarnessTokenClaims | null {
    return this.bridge?.verify(token) ?? null;
  }

  /** The gaia tools an agent's EFFECTIVE harness declares — read uniformly from
   * the registry, never branched on the harness id. Gates /api/harness/*. */
  harnessGaiaTools(workspace: Workspace, agentId: string): readonly GaiaTool[] {
    const harness = workspace.agents[agentId]?.harness ?? workspace.config.harness ?? DEFAULTS.harness;
    return capabilitiesFor(harness).gaiaTools;
  }

  async harnessMemoryBatch(
    claims: HarnessTokenClaims,
    file: string,
    operations: Array<{ action: MemoryAction; content?: string; oldText?: string }>,
  ): Promise<MemoryMutationResult> {
    const service = await this.serviceFor(claims.workspaceId, claims.roomId);
    return service.mutateAgentMemoryBatch(claims.agentId, file, operations);
  }

  async harnessMemoryWrite(
    claims: HarnessTokenClaims,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const service = await this.serviceFor(claims.workspaceId, claims.roomId);
    return service.mutateAgentMemory(claims.agentId, file, action, options);
  }

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

  /** Hybrid DEEP recall for a harness turn (capability-gated by the caller;
   * §8: explicit invocation tolerates seconds, so it earns the reranker +
   * chunk-window expansion). Runs entirely daemon-side: index, embedder,
   * reranker, and room refs stay here. The asking room's active context
   * window is excluded (self-match, CALMem) and any degradation is stated in
   * the result — never silent. */
  async harnessRecall(
    claims: HarnessTokenClaims,
    query: string,
    limit?: number,
    options: { summarize?: boolean } = {},
  ): Promise<{ result: string; hits: MemorySearchHit[] }> {
    const record = await this.registry.find(claims.workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
    const service = await this.serviceFor(claims.workspaceId, claims.roomId);
    const memory = this.memoryServiceFor(claims.workspaceId, service.workspace, record.path);
    const context = await service.recallContext(claims.agentId);
    const request = { limit: limit && limit > 0 ? Math.min(limit, 25) : undefined, context };
    if (options.summarize) {
      const { text, degraded } = await memory.summarizeSearch(claims.agentId, query, request);
      const header = degraded.length ? `(recall degraded: ${degraded.join("; ")})\n` : "";
      return { result: text ? `${header}${text}` : `${header}no matches in memory or room history`, hits: [] };
    }
    const { hits, degraded } = await memory.deepSearch(claims.agentId, query, request);
    const header = degraded.length ? `(recall degraded: ${degraded.join("; ")})\n` : "";
    return { result: hits.length ? `${header}${formatMemoryHits(hits, { full: true })}` : `${header}no matches in memory or room history`, hits };
  }

  /** The scroll pager (§8): raw transcript window around a previous recall
   * hit. No LLM, no ranking — just the surrounding conversation. */
  async harnessRecallScroll(claims: HarnessTokenClaims, hitId: number, options: { span?: number; offset?: number } = {}): Promise<string> {
    const record = await this.registry.find(claims.workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
    const window = await scrollTranscriptWindow(record.path, hitId, options);
    return window ?? `no transcript hit with id ${hitId} — ids come from recall results ("hit N")`;
  }

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

  async applyThinking(workspaceId: string, agentId: string, level: string): Promise<{ scope: "call" | "agent"; message: string }> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const service = await this.serviceFor(workspaceId);

    const call = this.activeCall;
    if (call && call.workspaceId === workspaceId && call.info.agentId === agentId) {
      if (level === "") delete call.info.thinking;
      else call.info.thinking = level;
      this.broadcast({ type: "voice-status", workspaceId, roomId: call.info.roomId, voice: call.info });
      return { scope: "call", message: `Set @${agentId} thinking to ${level || "agent default"} for this call. It reverts on hang-up.` };
    }

    return { scope: "agent", message: await service.setAgentThinking(agentId, level) };
  }

  // --- voice call session -----------------------------------------------------------

  voiceFor(workspaceId: string | undefined): VoiceCallInfo | null {
    if (!workspaceId || !this.activeCall || this.activeCall.workspaceId !== workspaceId) return null;
    return this.activeCall.info;
  }

  async startVoiceCall(workspaceId: string, agentId: string, gaiaUrl: string): Promise<VoiceCallInfo> {
    const service = await this.serviceFor(workspaceId);
    const agent = service.workspace.agents[agentId];
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (this.activeCall) throw new Error(`Voice call already active with @${this.activeCall.info.agentId}`);
    if (this.voiceStarting) throw new Error("A voice call is already starting");

    const settings = await readVoiceSettings();

    // The call TTS resolves EXACTLY like read-aloud (agent.tts.engine over the
    // voice.json default): an engine that declares `callBridge` (claude-voice)
    // gets a gaia protocol bridge unmute talks to instead of the bundled moshi
    // TTS. Default (kyutai) → the native service, unchanged.
    const ttsChoice = resolveTtsChoice(agent, settings);
    let ttsEndpoint: string | undefined;
    if (ttsChoice.engine.callBridge) {
      const bridge = new TtsCallBridge({
        ensureTts: (onStatus) => this.voiceStack.ensureTts(ttsStackSettings(settings), onStatus),
        log: (message) => this.log(message),
      });
      const { wsUrl } = await bridge.start(ttsChoice.engine, ttsChoice.voice, settings);
      this.ttsBridge?.stop();
      this.ttsBridge = bridge;
      ttsEndpoint = wsUrl;
      this.log(`voice: routing @${agent.id}'s call TTS through the ${ttsChoice.engine.id} bridge (voice: ${ttsChoice.voice ?? "default"})`);
    }

    this.voiceStarting = true;
    let unmuteUrl: string;
    try {
      ({ unmuteUrl } = await this.voiceStack.ensureRunning(
        {
          unmuteUrl: settings.unmuteUrl,
          unmuteDir: settings.unmuteDir,
          autoStart: settings.autoStart,
          startTimeoutMs: settings.startTimeoutSec * 1000,
          silenceTimeoutSec: settings.speakOnSilence ? settings.silenceDelaySec : null,
          ttsEndpoint,
        },
        gaiaUrl,
        (message) => {
          this.broadcast({ type: "voice-status", workspaceId, roomId: service.roomId, voice: null, pending: { agentId: agent.id, message } });
        },
      ));
    } catch (error) {
      // A failed stack start must not leak the bridge listener.
      this.ttsBridge?.stop();
      this.ttsBridge = undefined;
      throw error;
    } finally {
      this.voiceStarting = false;
    }

    const info: VoiceCallInfo = {
      agentId: agent.id,
      roomId: service.roomId,
      unmuteUrl,
      // The bridge owns the voice (baked into its engine); leave the unmute
      // session voice unset so it never validates a claude voice name.
      ...(agent.voice && !ttsEndpoint ? { voice: agent.voice } : {}),
      // Voice latency: thinking defaults off during the call; the agent's own
      // level returns on hang-up (durably — survives a crash mid-call).
      ...(settings.disableThinking ? { thinking: "off" } : {}),
      startedAt: new Date().toISOString(),
    };
    if (settings.disableThinking) {
      await persistCallOverride({ agentId: agent.id, previousThinking: agent.thinking ?? "" }).catch(() => {});
    }
    this.activeCall = { workspaceId, info, settings };
    this.broadcast({ type: "voice-status", workspaceId, roomId: service.roomId, voice: info });
    return info;
  }

  async stopVoiceCall(workspaceId: string): Promise<void> {
    if (this.activeCall && this.activeCall.workspaceId === workspaceId) {
      const ended = this.activeCall;
      this.activeCall = undefined;
      await clearCallOverride().catch(() => {});
      this.broadcast({ type: "voice-status", workspaceId, roomId: ended.info.roomId, voice: null });
    }
    // Tear down the TTS bridge (if this call used claude-voice), then stop
    // exactly the services GAIA spawned; external ones are left alone.
    this.ttsBridge?.stop();
    this.ttsBridge = undefined;
    this.voiceStack.stop();
  }

  /** One voice turn from the unmute backend (OpenAI-compat chat completions).
   * Returns the routing decision; the HTTP layer owns the response transport. */
  classifyTurn(body: unknown): ReturnType<typeof classifyVoiceTurn> {
    return classifyVoiceTurn(body);
  }

  /** Resolve a held context-gate: replay the new agent's first turn with the
   * chosen amount of context (full / last-N / compacted). */
  async resolveContextGate(workspaceId: string, roomId: string, choice: "full" | "last" | "compact", n?: number): Promise<void> {
    const service = await this.serviceFor(workspaceId, roomId);
    await service.resolveContextGate(choice, n);
  }

  /** Read one committed agent message aloud: resolve the author's TTS engine +
   * voice, format the text for speech, and return one chunk of the audio
   * (cached on disk; the result carries the chunk count for the client). */
  async readAloud(workspaceId: string, roomId: string, eventId: string, chunk = 0, regenerate = false): Promise<ReadAloudResult> {
    const service = await this.serviceFor(workspaceId, roomId);
    const event = await service.eventById(eventId);
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    const settings = await readVoiceSettings();
    return readAloud({
      event,
      agent: service.workspace.agents[event.author],
      settings,
      chunk,
      regenerate,
      ensureTts: (onStatus) => this.voiceStack.ensureTts(ttsStackSettings(settings), onStatus),
      log: (message) => this.log(message),
    });
  }

  /** Read a message aloud as the desktop app does: for engines that stream, one
   * continuous PCM pass played frame-by-frame (mode "stream"); for batch-only
   * engines (local TTS), mode "chunks" so the client keeps the per-chunk path.
   * The author's engine decides — this method never branches on the engine. */
  async readAloudStream(workspaceId: string, roomId: string, eventId: string, regenerate = false): Promise<ReadAloudDelivery> {
    const service = await this.serviceFor(workspaceId, roomId);
    const event = await service.eventById(eventId);
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    const settings = await readVoiceSettings();
    return readAloudStream({
      event,
      agent: service.workspace.agents[event.author],
      settings,
      regenerate,
      ensureTts: (onStatus) => this.voiceStack.ensureTts(ttsStackSettings(settings), onStatus),
      log: (message) => this.log(message),
    });
  }

  /** Transcribe one recorded clip → text (composer dictation / voice input).
   * Resolves the STT engine from voice.json (elevenlabs by default; swappable
   * like read-aloud's TTS engine, never branched on here) and returns the text.
   * Workspace-independent: it reads only global voice settings. */
  async transcribe(audio: SttAudioInput, opts: { engineId?: string; language?: string; signal?: AbortSignal } = {}): Promise<{ text: string; engine: string }> {
    const settings = await readVoiceSettings();
    return transcribe({
      audio,
      settings,
      engineId: opts.engineId,
      language: opts.language,
      signal: opts.signal,
      log: (message) => this.log(message),
    });
  }

  // --- files + hints -------------------------------------------------------------------

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

    this.hintSourcesCache ??= { toolNames: sdkToolNames(this.options.cwd), models: readModelCatalog().models };
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

  async workspaceForId(workspaceId: string): Promise<Workspace | undefined> {
    const key = this.workspaceServiceKeys(workspaceId)[0];
    const service = key ? this.services.get(key) : undefined;
    if (service) return service.workspace;
    const record = await this.registry.find(workspaceId);
    if (!record?.isInitialized) return undefined;
    return loadWorkspace(record.path);
  }

  // --- app payload -----------------------------------------------------------------------

  async appPayload(currentWorkspaceId?: string): Promise<{
    workspaces: WorkspaceRecord[];
    currentWorkspaceId: string | undefined;
    globalFiles: EditableFileDescriptor[];
    snapshot: Snapshot | undefined;
    workspaceFiles: EditableFileDescriptor[];
    voice: VoiceCallInfo | null;
  }> {
    const workspaces = await this.registry.list();
    const current = currentWorkspaceId ?? workspaces.find((workspace) => workspace.isInitialized)?.id;
    return {
      workspaces,
      currentWorkspaceId: current,
      globalFiles: await this.files.listGlobal(),
      snapshot: current ? await (await this.serviceFor(current)).getSnapshot() : undefined,
      workspaceFiles: current ? await this.files.listWorkspace(current) : [],
      voice: this.voiceFor(current),
    };
  }
}

// --- consolidation LLM (daemon-side, same credential store as the proxy) ---------

/** Builds the completion function consolidation uses. Resolved lazily per call
 * so key/model changes apply without a daemon restart; no key → the call
 * throws and consolidation skips with the error as its reason. */
function consolidateLlm(): ConsolidateLlm {
  return async ({ system, user, model }) => {
    const provider = model?.provider ?? DEFAULTS.model.provider;
    const name = model?.name ?? DEFAULTS.model.name;
    const [{ completeSimple }, { AuthStorage, ModelRegistry }] = await Promise.all([
      // completeSimple moved to the compat subpath in pi-ai 0.80 (same shape).
      import("@earendil-works/pi-ai/compat"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    const authStorage = AuthStorage.create();
    const resolved = ModelRegistry.create(authStorage).find(provider, name);
    if (!resolved) throw new Error(`consolidation model not found: ${provider}/${name}`);
    const apiKey = await authStorage.getApiKey(provider);
    const message = await completeSimple(
      resolved,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { ...(apiKey ? { apiKey } : {}), maxTokens: 4_000 },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "consolidation model call failed");
    }
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  };
}
