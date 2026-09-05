import { newId } from "../../core/ids.js";
import { DEFAULTS } from "../../core/config.js";
import type { AgentEvent, PetProgressStatus, Task, UiEvent } from "../../core/types.js";
import { deriveRoomTitle, isAutoRoomId, normalizeRoomTitle } from "../../domain/rooms.js";
import { HOOK_TEXT_CAP, runHooks, type HookEvent } from "../hooks.js";
import { applyEventToDetails } from "../turns.js";

export class RoomUiMixin {
  [key: string]: any;
  petTargetKey(taskId: string, agentId: string): string {
    return `${taskId}\u0000${agentId}`;
  }

  /** Emit one workspace-wide, room+agent-scoped pet update. The status is
   * derived only from the shared AgentEvent vocabulary in the caller below. */
  emitPetProgress(task: Task, agentId: string, status: PetProgressStatus, toolName?: string): void {
    this.emit({
      type: "pet-progress",
      workspaceId: this.workspaceId,
      roomId: this.roomId,
      agentId,
      taskId: task.id,
      status,
      ...(status === "tool" && toolName ? { toolName } : {}),
    });
  }

  settlePetTarget(task: Task, agentId: string, status: "done" | "failed"): void {
    const key = this.petTargetKey(task.id, agentId);
    if (this.settledPetTargets.has(key)) return;
    this.settledPetTargets.add(key);
    this.emitPetProgress(task, agentId, status);
  }

  createTask(text: string, targets: string[]): Task {
    return { id: newId("task"), roomId: this.roomId, text, targets, status: "running", startedAt: new Date().toISOString() };
  }

  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void {
    task.status = status;
    task.endedAt = new Date().toISOString();
    if (error !== undefined) task.error = error instanceof Error ? error.message : String(error);
    this.recentTasks = [...this.recentTasks.slice(-9), task];
    if (this.activeTask?.id === task.id) this.activeTask = undefined;
    if (this.activeAgentTurn?.id === task.id) this.activeAgentTurn = undefined;
    // Close the settle->drain gap now, synchronously, in the SAME tick as the
    // activeTask clear above — see `draining`'s doc comment. `resolveDraining`
    // fires from inside drain() the instant it has decided (see onDecided).
    let resolveDraining: () => void = () => {};
    this.draining = new Promise<void>((resolve) => {
      resolveDraining = resolve;
    });
    for (const agentId of task.targets) {
      if (this.startedPetTargets.has(this.petTargetKey(task.id, agentId))) {
        this.settlePetTarget(task, agentId, status === "complete" ? "done" : "failed");
      }
    }
    for (const agentId of task.targets) {
      this.settledPetTargets.delete(this.petTargetKey(task.id, agentId));
      this.startedPetTargets.delete(this.petTargetKey(task.id, agentId));
    }
    if (status === "error") {
      this.fireHooks("error", { taskId: task.id, agentIds: task.targets, error: (task.error ?? "").slice(0, HOOK_TEXT_CAP) });
      this.emit({ type: "task-error", workspaceId: this.workspaceId, roomId: this.roomId, task, error: task.error ?? "" });
    } else {
      this.emit({ type: "task-end", workspaceId: this.workspaceId, roomId: this.roomId, task });
    }
    void this.emitRoomsChanged();
    // Emit the settle snapshot BEFORE draining the next queued turn. SSE is a
    // single ordered stream and the client REPLACES its snapshot wholesale, so a
    // settle snapshot that got built before the drain commits the queued
    // message's user event must still be sent FIRST — otherwise a stale copy
    // lands after that room-event and blanks the just-committed bubble for the
    // whole next turn (the "queued message vanished after /compact" bug). The
    // drained turn then emits its own authoritative snapshot post-commit
    // (runAgentTask), which drops the ghost and keeps the committed bubble.
    void this.emitSnapshot()
      .catch(() => {})
      .finally(() => {
        void this.drain(resolveDraining).finally(() => {
          // Defensive: drain() always calls onDecided via its own try/finally,
          // but a second resolve() is a no-op, so this just guarantees the
          // promise can never dangle unresolved if drain() were ever changed.
          resolveDraining();
          if (this.draining) this.draining = undefined;
        });
      });
  }

  taskCancelled(task: Task): boolean {
    return task.status === "cancelled";
  }

  /** Observer hooks (config.json `hooks`), fire-and-forget: run at the room
   * layer, so they behave identically for every harness. Never awaited on the
   * turn path — a hook can neither block nor fail a turn. */
  fireHooks(event: HookEvent, payload: Record<string, unknown>): void {
    const hooks = this.workspace.config.hooks?.[event];
    if (!hooks?.length) return;
    void runHooks(hooks, event, { roomId: this.roomId, ...payload }, {
      cwd: this.workspace.rootDir,
      log: (message) => console.warn(`[gaia] ${message}`),
    });
  }

  /** Fold one streamed AgentEvent into the live-turn mirror. Delegates to the
   * SAME `applyEventToDetails` folder that builds the committed event's details
   * (turns.ts) — one shared implementation, so the mid-turn snapshot mirror, the
   * live client stream, and the final committed event agree by construction
   * (text + thinking + tools + ordered blocks). Guarded on eventId so a stray
   * event from a prior target can't bleed in. */
  applyLiveTurn(eventId: string, event: AgentEvent): void {
    const live = this.liveTurn;
    if (!live || live.eventId !== eventId) return;
    // Mirror the harness's own stall bookkeeping (RunnerHost.arm/clearStallDeadline):
    // an upstream-stall notice marks the turn as reconnecting so a client that
    // (re)subscribes mid-stall renders the retry state from the snapshot rather
    // than a frozen bubble; ANY real output (a non-notice event) proves the
    // harness recovered and clears it. Uniform for every harness — the notice is
    // harness-agnostic (no `=== "claude"` branch).
    if (event.type === "notice") {
      if (event.kind === "upstream-stall") live.stalled = true;
    } else if (live.stalled) {
      live.stalled = false;
    }
    if (event.type === "text-delta") live.text += event.delta;
    applyEventToDetails(live.details, event);
  }

  toUiEvent(taskId: string, agentId: string, eventId: string, event: AgentEvent): UiEvent | undefined {
    const scope = { workspaceId: this.workspaceId, roomId: this.roomId, taskId, agentId, eventId };
    switch (event.type) {
      case "model-info":
        return { ...scope, type: "model-info", provider: event.provider, modelId: event.modelId, subscription: event.subscription };
      case "model-fallback":
        return { ...scope, type: "model-fallback", fromModel: event.fromModel, toModel: event.toModel, reason: event.reason };
      case "context-usage":
        // The onEvent handler has already stored the resolved window (turn-end
        // value, last-known, or a-priori fallback); ride it out so the live chip
        // renders a % even before the harness reports the window at turn-end.
        return { ...scope, type: "context-usage", usedTokens: event.usedTokens, maxTokens: event.maxTokens ?? this.contextUsage[agentId]?.maxTokens };
      case "text-delta":
        return { ...scope, type: "text-delta", delta: event.delta };
      case "thinking-start":
        return { ...scope, type: "thinking-start" };
      case "thinking-delta":
        return { ...scope, type: "thinking-delta", delta: event.delta };
      case "thinking-end":
        return { ...scope, type: "thinking-end", content: event.content };
      case "skill-invocation":
        return { ...scope, type: "skill-invocation", skill: event.skill };
      case "tool-start":
        return { ...scope, type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
      case "tool-update":
        return { ...scope, type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult };
      case "tool-end":
        return { ...scope, type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
      case "steered":
        return { ...scope, type: "steered", steerEventId: event.eventId };
      case "ui.widget":
        return { ...scope, type: "ui.widget", id: event.id, placement: event.placement, lines: event.lines };
      case "ui.prompt":
        return { ...scope, type: "ui.prompt", id: event.id, kind: event.kind, title: event.title, message: event.message, fields: event.fields };
      case "ui.shortcut":
        return { ...scope, type: "ui.shortcut", commandId: event.commandId, key: event.key, description: event.description };
      case "auth.request":
        return { ...scope, type: "auth.request", id: event.id, providerId: event.providerId, method: event.method, url: event.url, instructions: event.instructions, deviceCode: event.deviceCode, fields: event.fields };
      case "ext.lifecycle":
        return { ...scope, type: "ext.lifecycle", id: event.id, state: event.state, reason: event.reason };
      case "ext.commands":
        return { ...scope, type: "ext.commands", commands: event.commands };
      case "harness.event":
        return { ...scope, type: "harness.event", kind: event.kind, payload: event.payload };
      case "notice":
        // Not a UI transport event — no-op. Never rendered as reply text.
        return undefined;
    }
  }

  async emitSnapshot(): Promise<void> {
    this.emit({ type: "snapshot", workspaceId: this.workspaceId, roomId: this.roomId, snapshot: await this.getSnapshot() });
  }

  emit(event: UiEvent): void {
    this.bus.emit(event);
  }

  /** Broadcast the workspace's room list to EVERY client in the workspace (no
   * roomId scope), so a sidebar updates a room's running dot / unread badge even
   * when that room isn't the one being viewed — the per-room SSE only carries
   * the open room's own events. Best-effort chrome; never breaks a turn. */
  async emitRoomsChanged(): Promise<void> {
    try {
      this.emit({ type: "rooms", workspaceId: this.workspaceId, rooms: await this.listRooms() });
    } catch {
      // A rooms refresh is decorative; a failed disk read must not surface.
    }
  }

  /** Give an auto-created room (a `chat-<slug>` id) a display title from its
   * first human message. We do what Claude/Codex-style chat UIs effectively do:
   * show a cheap local title immediately, then (best-effort) ask the same
   * daemon LLM surface used for consolidation/compact to refine it into a short
   * human label. Manual renames set `titleSource: manual`, and that state is the
   * lock: background title jobs never overwrite it. */
  async maybeAutoTitle(text: string): Promise<void> {
    if (this.incognito || !isAutoRoomId(this.roomId)) return;
    const state = await this.room.state();
    if (state.title || state.imported || state.titleSource === "manual") return;
    const fallback = deriveRoomTitle(text);
    if (!fallback) return;

    await this.room.updateState((current: any) => {
      if (!current.title && !current.imported && current.titleSource !== "manual") {
        current.title = fallback;
        current.titleSource = "auto";
      }
    });
    await this.emitRoomsChanged();

    if (this.options.llm) void this.refineAutoTitle(text, fallback);
  }

  async refineAutoTitle(firstMessage: string, fallback: string): Promise<void> {
    try {
      const reply = await this.options.llm?.({
        system:
          "You name chat rooms. Return ONLY a concise title, 2-6 words, no quotes, no period. Preserve key project or product names. Do not mention the assistant.",
        user: `First user message:
${firstMessage}

Title:`,
        model: DEFAULTS.roomTitleModel,
      });
      const title = normalizeRoomTitle(reply ?? "");
      if (!title || title === fallback) return;
      let changed = false;
      await this.room.updateState((current: any) => {
        if (current.titleSource === "auto" && current.title === fallback && !current.imported) {
          current.title = title;
          current.titleSource = "model";
          changed = true;
        }
      });
      if (changed) await this.emitRoomsChanged();
    } catch {
      // A title is chrome, not turn durability. Keep the local fallback.
    }
  }

  unknownAgentMessage(agentId: string): string {
    return `Unknown agent: @${agentId}\nAvailable agents: ${Object.keys(this.workspace.agents)
      .map((id) => `@${id}`)
      .join(", ")}`;
  }}

export function installRoomUi(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomUiMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomUiMixin.prototype, name)!);
  }
}
