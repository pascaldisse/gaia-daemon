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
import { gaiaHome, globalPaths } from "./core/paths.js";
import { readJson, writeJsonAtomic } from "./core/store.js";
import type { AgentDef, Snapshot, UiEvent, VoiceCallInfo, Workspace } from "./core/types.js";
import { capabilitiesFor, type GaiaTool } from "./harness/spec.js";
import { reapOrphans } from "./harness/reaper.js";
import type { MemoryAction, MemoryMutationResult } from "./domain/memory.js";
import { MemoryStore } from "./domain/memory.js";
import { ensureWorkspaceRoom, initWorkspace, loadWorkspace, setWorkspaceDefaultAgent, setWorkspaceRoom, workspacePath } from "./domain/workspace.js";
import { RoomService } from "./services/room-service.js";
import { MemoryService } from "./services/memory-service.js";
import { SchedulerService } from "./services/scheduler.js";
import type { ConsolidateLlm } from "./services/consolidate.js";
import { formatMemoryHits, type MemorySearchHit, type RoomSearchRef } from "./domain/memory-index.js";
import { SummonCoordinator } from "./services/summons.js";
import { HarnessBridge, type HarnessTokenClaims } from "./services/bridge.js";
import { resolveUpstreamCredential, type UpstreamCredential } from "./services/proxy.js";
import { EditableFileRegistry, buildFileHints, readModelCatalog, sdkThinkingLevels, sdkToolNames, type EditableFileContent, type EditableFileDescriptor, type FileHints, type HintSources, type ModelChoice } from "./services/hints.js";
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
import { readAloud, ttsStackSettings, type ReadAloudResult } from "./services/read-aloud.js";

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
  private readonly summonCoordinators = new Map<string, SummonCoordinator>();
  private readonly bus = new Bus<UiEvent>();
  private readonly pendingReloads = new Set<string>();
  private hintSourcesCache: { toolNames: string[]; models: ModelChoice[] } | undefined;
  private bridge: HarnessBridge | undefined;
  private scheduler: SchedulerService | undefined;
  /** One voice call at a time; unmute's chat-completions requests bind to it. */
  activeCall: { workspaceId: string; info: VoiceCallInfo; settings: VoiceSettings } | undefined;
  voiceStarting = false;

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
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.bus.on(listener);
  }

  broadcast(event: UiEvent): void {
    this.bus.emit(event);
  }

  dispose(): void {
    this.scheduler?.dispose();
    this.voiceStack.stop();
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
    service.subscribe((event) => this.broadcast(event));
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
      workspaceMemory: () => live.workspace.config.memory,
      agents: () => live.workspace.agents,
      memoryStore: this.memoryStoreFor(workspaceId),
      roomsFor: () => this.recentRoomRefs(path),
      llm: consolidateLlm(),
      log: (message) => this.log(message),
    });
    this.memoryServices.set(workspaceId, { service, live });
    return service;
  }

  /** Every room transcript in the workspace, most-recently-active first, for
   * cross-room recall. Uncapped on purpose: rooms are chats, and an agent must
   * be able to recall ANY of them by full text — including a 100-chat history
   * import — not just the recently touched ones. Per-room indexes build
   * lazily inside searchTranscript, so cold rooms cost one build each. */
  private recentRoomRefs(workspaceRoot: string): RoomSearchRef[] {
    const roomsDir = join(workspaceRoot, ".gaia", "rooms");
    if (!existsSync(roomsDir)) return [];
    const refs: Array<RoomSearchRef & { mtime: number }> = [];
    for (const entry of readdirSync(roomsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const roomDir = join(roomsDir, entry.name);
      const transcriptPath = join(roomDir, "transcript.jsonl");
      if (!existsSync(transcriptPath)) continue;
      try {
        refs.push({ roomId: entry.name, transcriptPath, dbPath: join(roomDir, "recall.db"), mtime: statSync(transcriptPath).mtimeMs });
      } catch {
        // Room being deleted mid-scan; skip it.
      }
    }
    return refs.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _mtime, ...ref }) => ref);
  }

  private summonCoordinatorFor(workspaceId: string, workspace: Workspace, path: string): SummonCoordinator {
    let coordinator = this.summonCoordinators.get(workspaceId);
    if (!coordinator) {
      coordinator = new SummonCoordinator(workspace, path, (roomId) => this.serviceFor(workspaceId, roomId), workspace.config.maxSummonsPerRoom ?? DEFAULTS.maxSummonsPerRoom);
      this.summonCoordinators.set(workspaceId, coordinator);
    }
    return coordinator;
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

  async setAgentRole(workspaceId: string, roomId: string, agentId: string, role: string): Promise<SelectionPayload & { message: string }> {
    const service = await this.serviceFor(workspaceId, roomId);
    const message = await service.setRole(agentId, role);
    const snapshot = await service.getSnapshot();
    this.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId), message };
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

  async harnessMemoryWrite(
    claims: HarnessTokenClaims,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const service = await this.serviceFor(claims.workspaceId, claims.roomId);
    return service.mutateAgentMemory(claims.agentId, file, action, options);
  }

  /** Hybrid recall for a harness turn (capability-gated by the caller). Runs
   * entirely daemon-side: index, embeddings key, and cross-room refs stay here. */
  async harnessRecall(claims: HarnessTokenClaims, query: string, limit?: number): Promise<{ result: string; hits: MemorySearchHit[] }> {
    const record = await this.registry.find(claims.workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
    const workspace = (await this.serviceFor(claims.workspaceId, claims.roomId)).workspace;
    const memory = this.memoryServiceFor(claims.workspaceId, workspace, record.path);
    const hits = await memory.search(claims.agentId, query, { limit: limit && limit > 0 ? Math.min(limit, 25) : undefined });
    return { result: hits.length ? formatMemoryHits(hits) : "no matches in memory or room history", hits };
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
        },
        gaiaUrl,
        (message) => {
          this.broadcast({ type: "voice-status", workspaceId, roomId: service.roomId, voice: null, pending: { agentId: agent.id, message } });
        },
      ));
    } finally {
      this.voiceStarting = false;
    }

    const info: VoiceCallInfo = {
      agentId: agent.id,
      roomId: service.roomId,
      unmuteUrl,
      ...(agent.voice ? { voice: agent.voice } : {}),
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
    // Stops exactly the services GAIA spawned; external ones are left alone.
    this.voiceStack.stop();
  }

  /** One voice turn from the unmute backend (OpenAI-compat chat completions).
   * Returns the routing decision; the HTTP layer owns the response transport. */
  classifyTurn(body: unknown): ReturnType<typeof classifyVoiceTurn> {
    return classifyVoiceTurn(body);
  }

  /** Read one committed agent message aloud: resolve the author's TTS engine +
   * voice, format the text for speech, and return one chunk of the audio
   * (cached on disk; the result carries the chunk count for the client). */
  async readAloud(workspaceId: string, roomId: string, eventId: string, chunk = 0): Promise<ReadAloudResult> {
    const service = await this.serviceFor(workspaceId, roomId);
    const event = await service.eventById(eventId);
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    const settings = await readVoiceSettings();
    return readAloud({
      event,
      agent: service.workspace.agents[event.author],
      settings,
      chunk,
      ensureTts: (onStatus) => this.voiceStack.ensureTts(ttsStackSettings(settings), onStatus),
      log: (message) => this.log(message),
    });
  }

  // --- files + hints -------------------------------------------------------------------

  async fileHints(file: EditableFileContent, workspaceId?: string): Promise<FileHints | undefined> {
    if (file.kind !== "json") return undefined;

    let agentIds: string[] = [];
    let roomIds: string[] = [];
    if (workspaceId) {
      try {
        const service = await this.serviceFor(workspaceId);
        agentIds = Object.keys(service.workspace.agents);
        roomIds = (await service.listRooms()).map((room) => room.id);
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
