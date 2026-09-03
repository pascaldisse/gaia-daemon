import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { attachmentMime, sanitizeAttachmentName } from "../../core/attachments.js";
import { mintedAt, newId } from "../../core/ids.js";
import { readJson, writeJsonAtomic } from "../../core/store.js";
import { globalPaths, workspacePaths } from "../../core/paths.js";
import type { AgentDef, AgentStatus, MessageAttachment, PendingTurn, RoomEvent, Snapshot } from "../../core/types.js";
import type { MemoryAction, MemoryMutationResult } from "../../domain/memory.js";
import { displayEventText } from "../../domain/render-cap.js";
import { normalizeRoomState, normalizeRoomTitle } from "../../domain/rooms.js";
import { listAgentRoles } from "../../domain/roles.js";
import { harnessIdFor, usageAccountFor } from "../../harness/spec.js";
import { configuredModelLabel } from "../../harness/model-label.js";
import { sdkThinkingLevels } from "../hints.js";

interface AmbientWatchdog { toolCalls: number; messages: string[]; label?: string; }
function ambientWatchdogPath(roomId: string): string { return join(globalPaths.ambientWatchdogDir(), `${roomId}.json`); }
export function readAmbientWatchdog(roomId: string): AmbientWatchdog | undefined {
  const path = ambientWatchdogPath(roomId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const toolCalls = parsed?.toolCalls; const messages = parsed?.messages; const label = parsed?.label;
    if (typeof toolCalls === "number" && Number.isFinite(toolCalls) && Math.floor(toolCalls) > 0 && Array.isArray(messages) && messages.length > 0 && messages.every((m: unknown) => typeof m === "string" && m.trim().length > 0)) return { toolCalls: Math.floor(toolCalls), messages, ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}) };
    return undefined;
  } catch { return undefined; }
}

export class RoomSnapshotMixin {
  [key: string]: any;
  /** Page backwards through committed history: the `limit` events immediately
   * before `beforeId` (or the transcript tail when it's absent/unknown). Backs
   * the transcript's "load older" — the snapshot only carries the tail window. */
  /** Maps stored events to what a client should see: identical except any
   * event carrying a command-plugin render cap (AgentRoomEvent.renderCap,
   * resolved once at commit time — see #commitReply) gets its text capped on
   * the way out, via the SAME derivation the live emit and read-aloud use
   * (domain/render-cap.ts#displayEventText), with its `note` (if any)
   * expanded into a separate synthesized system-authored chrome event right
   * after it (see withRenderCapNotes) — never merged into the agent's own
   * text. Storage/memory/hooks/recall (RoomHandle#eventsFrom directly) never
   * route through this — only client-facing reads do (root-cause fix,
   * Pascal, 2026-08-23: truncating the STORED text was destroying real
   * replies; the fix moves the cap to every read-out-for-display call site
   * instead of commit time). */
  displayEvents(events: RoomEvent[]): RoomEvent[] {
    return this.withRenderCapNotes(events);
  }

  /** Shared expansion used by both the live commit-time emit (#commitReply)
   * and every stored-history display read (#displayEvents): a plain 1:1 map,
   * except an event carrying a `renderCap` gets its displayed text capped,
   * and — when the cap carries a `note` — a SEPARATE system-authored chrome
   * event is inserted right after it, synthesized fresh every time from the
   * stored (text, renderCap) pair, never persisted on its own and never
   * merged into the agent's own message. */
  withRenderCapNotes(events: RoomEvent[]): RoomEvent[] {
    return events.flatMap((event: RoomEvent) => {
      if (!("renderCap" in event) || !event.renderCap) return [event];
      const capped: RoomEvent = { ...event, text: displayEventText(event.text, event.renderCap) };
      if (!event.renderCap.note) return [capped];
      const note: RoomEvent = { id: `${event.id}:cap-note`, timestamp: event.timestamp, author: "system", text: event.renderCap.note };
      return [capped, note];
    });
  }

  async eventsBefore(beforeId: string | undefined, limit: number): Promise<{ events: RoomEvent[]; hasMore: boolean }> {
    await this.init();
    const { events } = await this.room.eventsFrom(0);
    const found = beforeId ? events.findIndex((event: RoomEvent) => event.id === beforeId) : -1;
    const end = found >= 0 ? found : events.length;
    const start = Math.max(0, end - Math.max(1, limit));
    return { events: this.displayEvents(events.slice(start, end)), hasMore: start > 0 };
  }

  async getSnapshot(): Promise<Snapshot> {
    await this.init();
    const all = (await this.room.eventsFrom(0)).events;
    const events = this.displayEvents(all.slice(-this.workspace.config.transcriptWindow));
    const state = await this.room.state();
    const pluginPanels = await this.pluginPanels(state);
    // The selected agent plus any agents actively executing this room's turn
    // are the only identities that can spend here. This is deliberately not
    // the workspace roster: an unrelated agent/account in another room must
    // never leak into this room's usage meter.
    const usageAgentIds = new Set([
      state.activeAgent ?? this.workspace.config.defaultAgent,
      ...(this.activeTask?.targets ?? []),
      // A room can have a genuine multi-agent conversation even while idle.
      // Its transcript is the durable membership evidence; workspace agents
      // that never spoke here remain excluded.
      ...all.flatMap((event: RoomEvent) => (event.author !== "user" && this.workspace.agents[event.author] ? [event.author] : [])),
    ]);
    const usageAccounts = [...usageAgentIds]
      .map((id) => this.workspace.agents[id])
      .flatMap((agent) => (agent ? [usageAccountFor(agent, this.workspace)] : []))
      .filter((account): account is string => Boolean(account));
    return {
      workspace: {
        id: this.workspaceId,
        rootDir: this.workspace.rootDir,
        configPath: this.workspace.configPath,
        defaultAgent: this.workspace.config.defaultAgent,
      },
      room: {
        id: this.roomId,
        statePath: this.room.statePath,
        events,
        eventTotal: all.length,
        ...(state.thanksDario ? { thanksDario: true } : {}),
        ...(state.activeAgent && this.workspace.agents[state.activeAgent] ? { activeAgent: state.activeAgent } : {}),
        ...(usageAccounts.length > 0 ? { usageAccounts: [...new Set(usageAccounts)] } : {}),
        ...(state.agentDialogue ? { agentDialogue: true } : {}),
        ...(state.petBindings ? { petBindings: { ...state.petBindings } } : {}),
        ...(pluginPanels ? { pluginPanels } : {}),
        ...(this.incognito ? { incognito: true } : {}),
        ...(this.sanitizeStatus ? { sanitize: this.sanitizeStatus } : {}),
        ...(this.contextGate ? { contextGate: this.contextGate } : {}),
        ...(this.liveTurn ? { liveTurn: this.liveTurn } : {}),
        ...(() => {
          const ambient = readAmbientWatchdog(this.roomId);
          return ambient ? { ambientWatchdog: { toolCalls: ambient.toolCalls, ...(ambient.label ? { label: ambient.label } : {}) } } : {};
        })(),
      },
      rooms: await this.listRooms(),
      commands: await this.paletteCommands(),
      agents: await Promise.all(
        ((Object.values(this.workspace.agents) as AgentDef[])).map(async (agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          icon: agent.icon,
          modelLabel: this.runtimes[agent.id]?.modelLabel ?? "unknown",
          configuredModel: configuredModelLabel(agent.model, "default"),
          ...(this.modelFallbacks[agent.id] ? { modelFallback: this.modelFallbacks[agent.id] } : {}),
          ...(this.contextFor(agent) ? { context: this.contextFor(agent) } : {}),
          tools: agent.tools,
          voice: agent.voice,
          thinking: state.thinkingOverrides[agent.id] ?? agent.thinking,
          activeRole: state.activeRoles[agent.id],
          defaultRole: agent.defaultRole,
          harness: harnessIdFor(agent, this.workspace),
          ...(agent.account ? { account: agent.account } : {}),
          ...(usageAccountFor(agent, this.workspace) ? { usageAccount: usageAccountFor(agent, this.workspace) } : {}),
          roles: await listAgentRoles(agent),
          status: (this.compactingAgents.has(agent.id)
            ? "compacting"
            : this.activeTask?.targets.includes(agent.id)
              ? "running"
              : "idle") as AgentStatus["status"],
          ...(this.compactProgress.has(agent.id) ? { compact: this.compactProgress.get(agent.id) } : {}),
          isDefault: agent.id === this.workspace.config.defaultAgent,
        })),
      ),
      tasks: [...this.recentTasks, ...(this.activeTask ? [this.activeTask] : []), ...this.queuedTasks],
      backgroundTasks: state.backgroundTasks ?? [],
      thinkingLevels: sdkThinkingLevels(),
      // Degradation is loud (§10): the composer shows these like the
      // model-fallback warning. Best-effort — health can never break a snapshot.
      ...(await this.memoryChips()),
    };
  }

  async memoryChips(): Promise<{ memoryChips?: string[] }> {
    try {
      const chips = (await this.options.memory?.healthChips?.()) ?? [];
      return chips.length ? { memoryChips: chips } : {};
    } catch {
      return {};
    }
  }

  async listRooms(): Promise<Snapshot["rooms"]> {
    const roomsDir = workspacePaths.roomsDir(this.workspace.rootDir);
    const base = await scanRoomActivity(this.workspace.rootDir);
    if (base.length === 0) return [{ id: this.roomId, path: join(roomsDir, this.roomId), isCurrent: true }];
    // Overlay this live service's view on the disk scan: which room is open, its
    // in-memory turn (the durable pendingTurn marker lands a tick later, so this
    // closes the start-of-turn gap), and any live summon children (whose markers
    // likewise trail their start).
    const running = new Set(this.options.summonHost?.runningChildren().map((child: { roomId: string }) => child.roomId) ?? []);
    return base.map((room) => {
      const isCurrent = room.id === this.roomId;
      const live = room.running || running.has(room.id) || (isCurrent && Boolean(this.activeAgentTurn));
      return { ...room, isCurrent, ...(live ? { running: true } : {}) };
    });
  }

  /** Human rename. This is display metadata only: the durable room id/path stay
   * unchanged, so transcripts, tabs, summons, and references don't break. */
  async setTitle(rawTitle: string): Promise<void> {
    const title = normalizeRoomTitle(rawTitle);
    if (!title) throw new Error("Room title cannot be empty.");
    await this.room.updateState((state: any) => {
      state.title = title;
      state.titleSource = "manual";
    });
    await this.emitRoomsChanged();
  }

  /** Human favorite flag. Like title, this is display metadata only: the durable
   * room id/path stay stable and no transcript/memory semantics change. */
  async setFavorite(favorite: boolean): Promise<void> {
    await this.room.updateState((state: any) => {
      if (favorite) state.favorite = true;
      else delete state.favorite;
    });
    await this.emitRoomsChanged();
  }

  /** Human-membership allowlist (RoomState.humans). Absent/empty = today's
   * unrestricted default — enforcement (server/http.ts) only kicks in once a
   * room has at least one human explicitly added. */
  async roomHumans(): Promise<string[]> {
    await this.init();
    return (await this.room.state()).humans ?? [];
  }

  async inviteHuman(userId: string): Promise<string[]> {
    await this.init();
    const state = await this.room.updateState((state: any) => {
      const set = new Set(state.humans ?? []);
      set.add(userId);
      state.humans = [...set];
    });
    await this.emitRoomsChanged();
    return state.humans ?? [];
  }

  /** Removing the LAST member clears the allowlist back to unrestricted
   * (empty array is never persisted — normalizeRoomState drops it), not a
   * zero-human room nobody can post in. */
  async removeHuman(userId: string): Promise<string[]> {
    await this.init();
    const state = await this.room.updateState((state: any) => {
      const kept = (state.humans ?? []).filter((id: string) => id !== userId);
      if (kept.length > 0) state.humans = kept;
      else delete state.humans;
    });
    await this.emitRoomsChanged();
    return state.humans ?? [];
  }

  /** The most recent reply text from an agent in this room (summon results). */
  async latestReplyFrom(agentId: string): Promise<string> {
    await this.init();
    const events = await this.room.recentEvents(this.workspace.config.transcriptWindow);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author === agentId && "text" in event) return event.text;
    }
    return "";
  }

  // --- attachments -------------------------------------------------------------

  /** Persist a pasted file into this room's files/ dir (backs the upload
   * route). The daemon issues the on-disk id; `name` stays the original
   * client-side filename for display and prompts. */
  async storeAttachment(name: string, data: Buffer, mime?: string): Promise<MessageAttachment & { id: string }> {
    const safe = sanitizeAttachmentName(name);
    const id = `${newId("f")}-${safe}`;
    const dir = workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, id);
    await writeFile(path, data);
    return { id, name: name.trim() || safe, mime: mime?.trim() || attachmentMime(safe), size: data.byteLength, path };
  }

  /** Re-resolve client-sent attachment refs against this room's files dir.
   * Only the server-issued id is trusted for path math (basename'd, must
   * exist inside the dir); name/mime are display strings from the upload
   * response. Throws on an unknown id so a bad send fails loudly. */
  async resolveAttachments(refs: { id: string; name?: string; mime?: string }[]): Promise<MessageAttachment[]> {
    const dir = workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId);
    const attachments: MessageAttachment[] = [];
    for (const ref of refs) {
      const id = basename(ref.id.trim());
      if (!id || id.startsWith(".")) throw new Error(`Invalid attachment id: ${ref.id}`);
      const path = join(dir, id);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`Unknown attachment: ${id} — upload it first.`);
      attachments.push({
        name: ref.name?.trim() || id,
        mime: ref.mime?.trim() || attachmentMime(id),
        size: info.size,
        path,
      });
    }
    return attachments;
  }

  /** Absolute path of a stored attachment by id, for the serve route. */
  attachmentPath(id: string): string {
    return join(workspacePaths.roomFilesDir(this.workspace.rootDir, this.roomId), basename(id));
  }

  /** Memory write for a harness subprocess (the `gaia mem` CLI). The daemon is
   * the single writer; caps and secret filter match the in-process path. */
  async mutateAgentMemory(
    agentId: string,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));
    return this.options.memoryStore.mutate(agent.memoryDir, file, action, options);
  }

  /** Atomic batch memory write (§5): validated against the FINAL budget,
   * committed under one write — same guarded path as single ops. */
  async mutateAgentMemoryBatch(
    agentId: string,
    file: string,
    operations: Array<{ action: MemoryAction; content?: string; oldText?: string }>,
  ): Promise<MemoryMutationResult> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));
    return this.options.memoryStore.mutateBatch(agent.memoryDir, file, operations);
  }

}

export function installRoomSnapshot(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomSnapshotMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomSnapshotMixin.prototype, name)!);
  }
}

/**
 * Disk-only scan of a workspace's rooms — the shared basis for both the sidebar
 * room list (RoomService.listRooms overlays its live state on top) and the
 * cross-workspace activity rollup the app payload / `rooms` broadcasts feed to
 * the sidebar's workspace-level dots. Everything here is readable from each
 * room's durable state.json + transcript mtime, so it needs NO live service:
 * `running` comes from the durable pendingTurn marker alone (a resident service
 * adds its in-flight in-memory turn + live summon children), and `isCurrent` is
 * always false (it's relative to a service's open room, which a rollup lacks).
 * Rooms are chats: ordered by last transcript write, newest first.
 */
/** Sidebar drag-drop reorder for a workspace's top-level rooms — same shape
 * as WorkspaceRegistry's order field, stored in its own small per-workspace
 * file (.gaia/room-order.json) rather than per-room state, so persisting a
 * full drag is one atomic write. Ids outside the array (never dragged, or a
 * summon child — those aren't reorderable) fall through to activity order. */
async function readRoomOrder(rootDir: string): Promise<string[]> {
  const doc = (await readJson(workspacePaths.roomOrder(rootDir))) as { order?: string[] } | undefined;
  return doc?.order ?? [];
}
export async function writeRoomOrder(rootDir: string, ids: string[]): Promise<void> {
  await writeJsonAtomic(workspacePaths.roomOrder(rootDir), { order: ids });
}

function runningSince(turn: PendingTurn): string | undefined {
  const startedAt = Date.parse(turn.startedAt);
  if (Number.isFinite(startedAt)) return new Date(startedAt).toISOString();
  return turn.eventId ? mintedAt(turn.eventId) : undefined;
}

export async function scanRoomActivity(rootDir: string): Promise<Snapshot["rooms"]> {
  const roomsDir = workspacePaths.roomsDir(rootDir);
  if (!existsSync(roomsDir)) return [];
  const entries = await readdir(roomsDir, { withFileTypes: true });
  const order = await readRoomOrder(rootDir);
  const orderPos = new Map(order.map((id, index) => [id, index]));
  const rooms = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const state = normalizeRoomState(await readJson(workspacePaths.roomState(rootDir, entry.name)));
        const activity = await stat(workspacePaths.transcript(rootDir, entry.name)).then(
          (info) => info.mtimeMs,
          () => 0,
        );
        const running = state.pendingTurn;
        const since = running ? runningSince(running) : undefined;
        return {
          activity,
          summary: {
            id: entry.name,
            path: join(roomsDir, entry.name),
            isCurrent: false,
            ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
            ...(running ? { running: true, ...(since ? { runningSince: since } : {}) } : {}),
            ...(state.title ? { title: state.title } : {}),
            ...(state.favorite ? { favorite: true } : {}),
            ...(state.imported ? { imported: state.imported } : {}),
            ...(state.incognito ? { incognito: true } : {}),
            ...(activity ? { lastActivity: activity } : {}),
          } as Snapshot["rooms"][number],
        };
      }),
  );
  rooms.sort((a, b) => {
    // Manual drag order (see writeRoomOrder) wins outright over activity —
    // same precedence rule as WorkspaceRegistry.list, minus the favorites-lead
    // clause (rooms are favorite-FILTERED via the sidebar toggle, not
    // favorite-sorted, so favorite status doesn't affect this ordering).
    const ao = orderPos.get(a.summary.id);
    const bo = orderPos.get(b.summary.id);
    if (ao !== undefined && bo !== undefined) return ao - bo;
    if (ao !== undefined) return -1;
    if (bo !== undefined) return 1;
    return b.activity - a.activity || a.summary.id.localeCompare(b.summary.id);
  });
  return rooms.map((room) => room.summary);
}
