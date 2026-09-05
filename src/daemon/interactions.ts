import { globalPaths } from "../core/paths.js";
import type { AgentDef, Snapshot, UiEvent, VoiceCallInfo, Workspace, WorkspaceRecord } from "../core/types.js";
import { DEFAULT_ROOM, ensureWorkspaceRoom, initWorkspace, isValidRoomId, loadWorkspace, setWorkspaceDefaultAgent, setWorkspaceRoom, trashWorkspaceRoom } from "../domain/workspace.js";
import { setAgentDefaultRole, trashGlobalAgent } from "../domain/agents.js";
import { listAgentRoles } from "../domain/roles.js";
import type { MemoryStore } from "../domain/memory.js";
import { RoomService, writeRoomOrder } from "../services/room-service.js";
import { MemoryService } from "../services/memory-service.js";
import { VoiceStackManager, classifyVoiceTurn, clearCallOverride, persistCallOverride, readVoiceSettings, type VoiceSettings } from "../services/voice.js";
import { readAloud, readAloudStream, resolveTtsChoice, ttsStackSettings, type ReadAloudDelivery, type ReadAloudResult, type TtsOverrides } from "../services/read-aloud.js";
import { transcribe, type SttAudioInput } from "../services/transcribe.js";
import { TtsCallBridge } from "../services/voice-tts-bridge.js";
import { SttCallBridge } from "../services/voice-stt-bridge.js";
import type { SummonCoordinator } from "../services/summons.js";
import { roomIdsOnDisk, serviceKey } from "./wiring.js";
import { sdkThinkingLevels } from "../services/hints.js";
import type { Daemon } from "../daemon.js";
import type { RoomInteractionHost } from "./ports.js";

export interface SelectionPayload {
  snapshot: Snapshot;
  workspaceFiles: import("../services/hints.js").EditableFileDescriptor[];
  voice: VoiceCallInfo | null;
}

/** Room, agent, and voice interaction lifecycle; daemon supplies only this typed port. */
export class RoomInteractionLifecycle {
  readonly voiceStack = new VoiceStackManager(globalPaths.voiceLogsDir());
  activeCall: { workspaceId: string; info: VoiceCallInfo; settings: VoiceSettings } | undefined;
  voiceStarting = false;
  private ttsBridge: TtsCallBridge | undefined;
  private sttBridge: SttCallBridge | undefined;

  constructor(private readonly host: RoomInteractionHost) {}

  dispose(): void {
    this.ttsBridge?.stop();
    this.sttBridge?.stop();
    this.voiceStack.stop();
  }

  async addWorkspace(path: string, humanId?: string): Promise<WorkspaceRecord> {
    let record = await this.host.registry.add(path, humanId);
    if (!record.isInitialized) {
      // Adding through the UI is an explicit "make this a GAIA workspace".
      await initWorkspace(record.path);
      record = await this.host.registry.add(record.path, humanId);
    }
    await this.host.serviceFor(record.id);
    return record;
  }

  /** Mark/unmark a workspace favorite (sidebar right-click). Display metadata
   * only — see WorkspaceRegistry.setFavorite. */
  async setWorkspaceFavorite(workspaceId: string, favorite: boolean, humanId?: string): Promise<{ workspaces: WorkspaceRecord[] }> {
    const found = await this.host.registry.setFavorite(workspaceId, favorite, humanId);
    if (!found) throw new Error(`Unknown workspace: ${workspaceId}`);
    return { workspaces: await this.host.registry.listForHuman(humanId) };
  }

  /** Persist a sidebar drag-drop reorder of the workspace list. */
  async reorderWorkspaces(ids: string[], humanId?: string): Promise<{ workspaces: WorkspaceRecord[] }> {
    await this.host.registry.reorder(ids, humanId);
    return { workspaces: await this.host.registry.listForHuman(humanId) };
  }

  async selectRoom(workspaceId: string, roomId: string, opts?: { incognito?: boolean }): Promise<SelectionPayload> {
    const record = await this.host.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);

    // Each room keeps its own long-lived service, so switching is always safe;
    // only a live voice call (bound to one room) blocks it.
    if (this.activeCall?.workspaceId === workspaceId && this.activeCall.info.roomId !== roomId) {
      throw new Error("Stop the active voice call before switching rooms.");
    }

    // `incognito` only takes effect when this call CREATES the room (immutable
    // seed in ensureWorkspaceRoom); selecting an existing room ignores it.
    await ensureWorkspaceRoom(record.path, roomId, opts);
    await setWorkspaceRoom(record.path, roomId);
    this.host.currentRoom.set(workspaceId, roomId);

    const service = await this.host.serviceFor(workspaceId, roomId);
    const snapshot = await service.getSnapshot();
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  /** Rename a room's display title without changing its durable id/path. */
  async renameRoom(workspaceId: string, roomId: string, title: string): Promise<{ rooms: Snapshot["rooms"] }> {
    const service = await this.serviceForExistingRoom(workspaceId, roomId);
    await service.setTitle(title);
    return this.refreshRoomList(workspaceId);
  }

  /** Mark/unmark a room as a favorite. This is display metadata only: no
   * transcript, memory, sandbox, or harness behaviour changes. */
  async setRoomFavorite(workspaceId: string, roomId: string, favorite: boolean): Promise<{ rooms: Snapshot["rooms"] }> {
    const service = await this.serviceForExistingRoom(workspaceId, roomId);
    await service.setFavorite(favorite);
    return this.refreshRoomList(workspaceId);
  }

  /** Sidebar drag-drop reorder of a workspace's top-level rooms (mirrors
   * WorkspaceRegistry.reorder) — display order only, one atomic write to this
   * workspace's .gaia/room-order.json regardless of room count. */
  async reorderRooms(workspaceId: string, ids: string[]): Promise<{ rooms: Snapshot["rooms"] }> {
    const record = await this.host.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    await writeRoomOrder(record.path, ids);
    return this.refreshRoomList(workspaceId);
  }

  private async serviceForExistingRoom(workspaceId: string, roomId: string): Promise<RoomService> {
    const record = await this.host.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (!isValidRoomId(roomId)) throw new Error("Invalid room id.");
    if (!roomIdsOnDisk(record.path).includes(roomId)) throw new Error(`Room not found: ${roomId}`);
    return this.host.serviceFor(workspaceId, roomId);
  }

  /** Return/broadcast the room list relative to the currently viewed room, so
   * changing background room chrome never switches the user's active chat. */
  private async refreshRoomList(workspaceId: string): Promise<{ rooms: Snapshot["rooms"] }> {
    const current = await this.host.serviceFor(workspaceId);
    const rooms = await current.listRooms();
    this.host.broadcast({ type: "rooms", workspaceId, rooms });
    return { rooms };
  }

  /** Delete a room: dispose its live service, move its directory to the
   * workspace trash (reversible — never rm -rf), purge it from memory (index
   * rows + every agent's episodes), and reselect a neighbour so a room is always
   * in view. Refuses to delete a voice-call room or the last room. */
  async deleteRoom(workspaceId: string, roomId: string): Promise<SelectionPayload> {
    const record = await this.host.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (!isValidRoomId(roomId)) throw new Error("Invalid room id.");
    if (this.activeCall?.workspaceId === workspaceId && this.activeCall.info.roomId === roomId) {
      throw new Error("Stop the active voice call before deleting this room.");
    }

    const roomIds = roomIdsOnDisk(record.path);
    if (!roomIds.includes(roomId)) throw new Error(`Room not found: ${roomId}`);
    if (roomIds.length <= 1) throw new Error("Can't delete the only room in the workspace.");

    // Stop any in-flight turn before pulling the room out from under the WAL
    // writer, then drop the live service so nothing writes the doomed dir.
    const key = serviceKey(workspaceId, roomId);
    const service = this.host.services.get(key);
    if (service) {
      if (service.isBusy) await service.cancelActiveTask();
      await service.dispose();
      this.host.services.delete(key);
    }

    // Pick and persist the replacement BEFORE any post-trash workspace load.
    // loadWorkspace() always ensures config.room exists; if config.room still
    // points at the just-trashed room, it recreates an empty zombie directory
    // and the sidebar appears to ignore the delete.
    const current = this.host.currentRoom.get(workspaceId);
    const next = current && current !== roomId && roomIds.includes(current) ? current : (roomIds.find((id) => id !== roomId) ?? DEFAULT_ROOM);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trash = await trashWorkspaceRoom(record.path, roomId, stamp);
    await setWorkspaceRoom(record.path, next);
    this.host.currentRoom.set(workspaceId, next);

    const workspace = await loadWorkspace(record.path);
    const episodesPurged = await this.host.memoryServiceFor(workspaceId, workspace, record.path).purgeRoom(roomId, trash || undefined);
    this.host.log(`deleted room ${roomId} (ws ${workspaceId}) → trash ${trash || "(already gone)"}; purged ${episodesPurged} episode(s) from memory`);

    const nextService = await this.host.serviceFor(workspaceId, next);
    const snapshot = await nextService.getSnapshot();
    this.host.broadcast({ type: "rooms", workspaceId, rooms: await nextService.listRooms() });
    this.host.broadcast({ type: "pet-bindings", workspaceId, bindings: await this.host.petBindings(workspaceId) });
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: nextService.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  /** Remove a workspace from GAIA's registry (the recent-workspaces list). This
   * de-registers it and tears down its resident room services / memory service /
   * summon coordinator — it does NOT delete anything on disk: the workspace's
   * .gaia data and project files stay put, so re-adding the folder restores
   * everything. Refuses while a voice call is active in that workspace. Returns
   * the fresh app payload with a remaining workspace selected (or none, if this
   * was the last one). */
  async deleteWorkspace(workspaceId: string, humanId?: string): Promise<Awaited<ReturnType<Daemon["appPayload"]>>> {
    const record = await this.host.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    if (this.activeCall?.workspaceId === workspaceId) {
      throw new Error("Stop the active voice call before deleting this workspace.");
    }

    // Cancel any in-flight turn, then drop every resident room service for this
    // workspace so nothing keeps writing under a workspace we're forgetting.
    for (const key of this.host.workspaceServiceKeys(workspaceId)) {
      const service = this.host.services.get(key);
      if (!service) continue;
      if (service.isBusy) await service.cancelActiveTask();
      await service.dispose();
      this.host.services.delete(key);
    }
    const memory = this.host.memoryServices.get(workspaceId);
    if (memory) {
      memory.service.dispose();
      this.host.memoryServices.delete(workspaceId);
    }
    this.host.memoryStores.delete(workspaceId);
    this.host.summonCoordinators.delete(workspaceId);
    this.host.currentRoom.delete(workspaceId);

    await this.host.registry.remove(workspaceId, humanId);
    // The workspace's files remain on disk, but it no longer belongs to this
    // shell process: close its native pet windows immediately.
    this.host.broadcast({ type: "pet-bindings", workspaceId, bindings: [] });
    this.host.log(`removed workspace ${record.name} (${workspaceId}) from the registry; files left on disk`);

    // Select a remaining initialized workspace (if any) for the returned payload.
    const remaining = await this.host.registry.listForHuman(humanId);
    const nextCurrent = remaining.find((workspace) => workspace.isInitialized)?.id;
    return this.host.appPayload(nextCurrent, humanId);
  }

  async setAgentRole(workspaceId: string, roomId: string, agentId: string, role: string): Promise<SelectionPayload & { message: string }> {
    const service = await this.host.serviceFor(workspaceId, roomId);
    const message = await service.setRole(agentId, role);
    const snapshot = await service.getSnapshot();
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId), message };
  }

  /** Set an agent's GLOBAL default role (agent.json "role"), applied in every
   * room that has no per-room override. Empty/"none"/"default" clears it. */
  async setAgentDefaultRole(workspaceId: string, agentId: string, role: string): Promise<SelectionPayload> {
    const service = await this.host.serviceFor(workspaceId);
    const agent = service.workspace.agents[agentId];
    if (!agent) throw new Error(`Unknown agent: @${agentId}`);

    const normalized = role === "" || role === "none" || role === "default" ? undefined : role;
    if (normalized) {
      const roles = await listAgentRoles(agent);
      if (!roles.includes(normalized)) throw new Error(`Unknown role: ${normalized}`);
    }
    await setAgentDefaultRole(agent, normalized);

    const snapshot = await service.getSnapshot();
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  /** Run a declarative local-plugin panel action through its normal slash-command
   * state path, then return/broadcast the authoritative room snapshot. */
  async runPluginAction(workspaceId: string, roomId: string, command: string, args: string[]): Promise<SelectionPayload & { message: string }> {
    const service = await this.host.serviceFor(workspaceId, roomId);
    const message = await service.runPluginAction(command, args);
    const snapshot = await service.getSnapshot();
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId), message };
  }

  /** Toggle room agent-dialogue (agents replying to each other's @mentions). */
  async setRoomAgentDialogue(workspaceId: string, roomId: string, on: boolean): Promise<SelectionPayload> {
    const service = await this.host.serviceFor(workspaceId, roomId);
    await service.setAgentDialogue(on);
    const snapshot = await service.getSnapshot();
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: service.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  async setDefaultAgent(workspaceId: string, agentId: string): Promise<SelectionPayload> {
    const record = await this.host.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);

    const service = await this.host.serviceFor(workspaceId);
    if (!service.workspace.agents[agentId]) throw new Error(`Unknown agent: @${agentId}`);
    await setWorkspaceDefaultAgent(record.path, agentId);

    // The default is workspace-wide: rebuild every resident room service.
    await Promise.all(this.host.workspaceServiceKeys(workspaceId).map((key) => this.host.reloadService(key)));
    const rebuilt = await this.host.serviceFor(workspaceId);
    const snapshot = await rebuilt.getSnapshot();
    this.host.broadcast({ type: "snapshot", workspaceId, roomId: rebuilt.roomId, snapshot });
    return { snapshot, workspaceFiles: await this.host.files.listWorkspace(workspaceId), voice: this.voiceFor(workspaceId) };
  }

  /** Delete a global agent: move its directory to the global trash (reversible —
   * never rm -rf). Refuses if the agent doesn't exist (checked against the disk,
   * not just in-memory loaded workspaces — trashGlobalAgent's own existsSync
   * catches an agent no workspace has loaded yet this session), or is any
   * currently-loaded workspace's default agent. */
  async deleteAgent(agentId: string): Promise<void> {
    for (const service of this.host.services.values()) {
      if (service.workspace.config.defaultAgent === agentId) {
        throw new Error(`Cannot delete @${agentId}: it's the default agent for workspace "${service.workspace.rootDir}"`);
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trash = await trashGlobalAgent(agentId, stamp);
    if (!trash) throw new Error(`Unknown agent: @${agentId}`);
    this.host.log(`deleted agent ${agentId} → trash ${trash}`);
  }

  // --- keep-awake (Global Settings ▸ General) ---------------------------------------

  /** Current keep-awake capability/state — served in /api/app. */

  async applyThinking(
    workspaceId: string,
    roomId: string | undefined,
    agentId: string,
    level: string,
  ): Promise<{ scope: "call" | "room"; message: string }> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }

    const call = this.activeCall;
    if (call && call.workspaceId === workspaceId && call.info.agentId === agentId) {
      if (level === "") delete call.info.thinking;
      else call.info.thinking = level;
      this.host.broadcast({ type: "voice-status", workspaceId, roomId: call.info.roomId, voice: call.info });
      return { scope: "call", message: `Set @${agentId} thinking to ${level || "agent default"} for this call. It reverts on hang-up.` };
    }

    const service = await this.host.serviceFor(workspaceId, roomId);
    return { scope: "room", message: await service.setRoomThinking(agentId, level) };
  }

  // --- voice call session -----------------------------------------------------------

  voiceFor(workspaceId: string | undefined): VoiceCallInfo | null {
    if (!workspaceId || !this.activeCall || this.activeCall.workspaceId !== workspaceId) return null;
    return this.activeCall.info;
  }

  async startVoiceCall(workspaceId: string, agentId: string, gaiaUrl: string): Promise<VoiceCallInfo> {
    const service = await this.host.serviceFor(workspaceId);
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
        log: (message) => this.host.log(message),
      });
      const { wsUrl } = await bridge.start(ttsChoice.engine, ttsChoice.voice, settings);
      this.ttsBridge?.stop();
      this.ttsBridge = bridge;
      ttsEndpoint = wsUrl;
      this.host.log(`voice: routing @${agent.id}'s call TTS through the ${ttsChoice.engine.id} bridge (voice: ${ttsChoice.voice ?? "default"})`);
    }

    // Replicate is one-shot transcription, so the bridge presents it as the
    // native unmute streaming STT protocol. kyutai remains the untouched native
    // default; unknown settings deliberately retain that safe default.
    let sttEndpoint: string | undefined;
    if (settings.callSttEngine === "replicate") {
      const bridge = new SttCallBridge({ log: (message) => this.host.log(message) });
      const { wsUrl } = await bridge.start(settings);
      this.sttBridge?.stop();
      this.sttBridge = bridge;
      sttEndpoint = wsUrl;
      this.host.log("voice: routing call STT through the Replicate bridge");
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
          sttEndpoint,
        },
        gaiaUrl,
        (message) => {
          this.host.broadcast({ type: "voice-status", workspaceId, roomId: service.roomId, voice: null, pending: { agentId: agent.id, message } });
        },
      ));
    } catch (error) {
      // A failed stack start must not leak the bridge listener.
      this.ttsBridge?.stop();
      this.ttsBridge = undefined;
      this.sttBridge?.stop();
      this.sttBridge = undefined;
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
    this.host.broadcast({ type: "voice-status", workspaceId, roomId: service.roomId, voice: info });
    return info;
  }

  async stopVoiceCall(workspaceId: string): Promise<void> {
    if (this.activeCall && this.activeCall.workspaceId === workspaceId) {
      const ended = this.activeCall;
      this.activeCall = undefined;
      await clearCallOverride().catch(() => {});
      this.host.broadcast({ type: "voice-status", workspaceId, roomId: ended.info.roomId, voice: null });
    }
    // Tear down call bridges, then stop exactly the services GAIA spawned;
    // externally started services are left alone.
    this.ttsBridge?.stop();
    this.ttsBridge = undefined;
    this.sttBridge?.stop();
    this.sttBridge = undefined;
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
    const service = await this.host.serviceFor(workspaceId, roomId);
    await service.resolveContextGate(choice, n);
  }

  /** Read one committed agent message aloud: resolve the author's TTS engine +
   * voice, format the text for speech, and return one chunk of the audio
   * (cached on disk; the result carries the chunk count for the client). */
  async readAloud(workspaceId: string, roomId: string, eventId: string, chunk = 0, regenerate = false, overrides: TtsOverrides = {}): Promise<ReadAloudResult> {
    const service = await this.host.serviceFor(workspaceId, roomId);
    // display:true — a collared room reads aloud the SAME capped text it
    // shows (09-DOG-MODE, Pascal 2026-08-23); the stored event keeps the full
    // reply, this just derives what a human hears.
    const event = await service.eventById(eventId, { display: true });
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    const settings = await readVoiceSettings();
    return readAloud({
      event,
      agent: service.workspace.agents[event.author],
      settings,
      chunk,
      regenerate,
      ...overrides,
      ensureTts: (onStatus) => this.voiceStack.ensureTts(ttsStackSettings(settings), onStatus),
      log: (message) => this.host.log(message),
    });
  }

  /** Read a message aloud as the desktop app does: for engines that stream, one
   * continuous PCM pass played frame-by-frame (mode "stream"); for batch-only
   * engines (local TTS), mode "chunks" so the client keeps the per-chunk path.
   * The author's engine decides — this method never branches on the engine. */
  async readAloudStream(workspaceId: string, roomId: string, eventId: string, regenerate = false, overrides: TtsOverrides = {}): Promise<ReadAloudDelivery> {
    const service = await this.host.serviceFor(workspaceId, roomId);
    // display:true — same reasoning as readAloud above.
    const event = await service.eventById(eventId, { display: true });
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    const settings = await readVoiceSettings();
    return readAloudStream({
      event,
      agent: service.workspace.agents[event.author],
      settings,
      regenerate,
      ...overrides,
      ensureTts: (onStatus) => this.voiceStack.ensureTts(ttsStackSettings(settings), onStatus),
      log: (message) => this.host.log(message),
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
      log: (message) => this.host.log(message),
    });
  }

  // --- files + hints -------------------------------------------------------------------

}
