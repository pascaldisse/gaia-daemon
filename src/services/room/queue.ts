import type { RoomEvent, Task, UiEvent, Workspace } from "../../core/types.js";
import type { RoomHandle } from "../../domain/rooms.js";
import { findHarness, harnessIdFor } from "../../harness/spec.js";
import { parseCommand, planMentionRoute, type SlashCommand } from "../commands.js";
import type { CommandPlugin, PluginResult } from "../plugins.js";
import type { SendMessageOptions } from "../room-service.js";

/** Typed service boundary for durable queue custody and message routing. */
export interface RoomQueuePort {
  readonly room: RoomHandle;
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly runtimes: Record<string, { capabilities: { supportsSteer: boolean } }>;
  readonly pluginsPromise: Promise<Map<string, CommandPlugin>>;
  activeTask: Task | undefined;
  activeAgentTurn: Task | undefined;
  queuedTasks: Task[];
  draining: Promise<void> | undefined;
  authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  activeTurnUnwind: Promise<void> | undefined;
  init(): Promise<void>;
  isMonadMessage(text: string, options: SendMessageOptions): Promise<boolean>;
  monadAuthor(): Promise<string[]>;
  nativeCommandTarget(): Promise<string>;
  endedConversationTargets(targets: readonly string[]): Promise<string[]>;
  reactivateConversation(targets: readonly string[]): Promise<void>;
  createTask(text: string, targets: string[]): Task;
  runPlugin(plugin: CommandPlugin, args: string[], command?: string): Promise<PluginResult>;
  runSteerCommand(text?: string, attachments?: SendMessageOptions["attachments"]): Promise<string>;
  runCancelCommand(): Promise<string>;
  steerRunningTurn(target: string, text: string, task: Task, attachments?: SendMessageOptions["attachments"], human?: SendMessageOptions["human"]): Promise<true | string>;
  runCommand(task: Task, command: SlashCommand): Promise<void>;
  runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void>;
  taskCancelled(task: Task): boolean;
  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void;
  unknownAgentMessage(agentId: string): string;
  emit(event: UiEvent): void;
  emitSnapshot(): Promise<void>;
  emitRoomsChanged(): Promise<void>;
}

type RoomCommand = SlashCommand;

/** Durable enqueue/drain hand-off; queue → pendingTurn remains atomic in RoomHandle. */
export class RoomQueue {
  constructor(private readonly service: RoomQueuePort) {}

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<Task> {
    await this.service.init();

    let command: RoomCommand = parseCommand(text);
    // Harness-native passthrough: an unrecognized `/command` becomes a command
    // TURN to the active agent when that agent has CHECKED that command as a
    // skill (claude builtins like deep-research) and its harness can run them.
    // No separate toggle — the skill list is the whitelist. Anything else stays
    // the "unknown command" reply. Rewritten to a message turn here so it rides
    // the normal WAL/queue/streaming path — just flagged nativeCommand.
    if (command.type === "unknown") {
      // Local command-plugin dispatch (see services/plugins.ts) — checked
      // BEFORE the native-passthrough rewrite below so a plugin's command name
      // always wins over any harness-native skill of the same name. Runs
      // synchronously here (not queued) so it can steer a turn that's live
      // RIGHT NOW; mirrors the /steer + /cancel gate's reply shape just below.
      const commandName = command.command;
      const plugin = (await this.service.pluginsPromise).get(commandName);
      if (plugin) {
        const args = text.trim().split(/\s+/).slice(1);
        const result = await this.service.runPlugin(plugin, args, commandName);
        // Generic message-intercept-to-real-turn (PluginResult.rewriteAsMessage
        // — e.g. plugins/defaults/dog-mode.mjs's discipline verbs): the plugin
        // already mutated its own state synchronously (via `result.state`
        // above, persisted inside runPlugin, BEFORE this line) — deliver the
        // ORIGINAL raw text as a real message turn addressed at
        // `result.targets`, falling through the FULL busy/queue/steer-by-
        // default pipeline below exactly like a plain "@agent ..." message, so
        // only the room's agent ever generates the actual reply. Never an
        // early return — unlike the steer/reply branch just below.
        if (result.rewriteAsMessage) {
          const target = result.targets?.[0] ?? (await this.roomDefaultTarget());
          command = { type: "message", text };
          options = { ...options, targets: result.targets ?? [target], pluginMessageTurn: true };
        } else if (result.steer) {
          // A plugin's `steer` is guidance meant to actually REACH an agent, not
          // to be echoed back to the user as a system note — the steer delivery
          // itself (mid-turn injection bubble, or a real message when nothing's
          // running) is the only visible trace. Generic for any plugin, not
          // just whip. `reply` (e.g. a counter) is silent bookkeeping here, not
          // shown — a plugin wanting a REPLY shown returns no `steer` at all.
          if (this.service.activeAgentTurn) {
            const pluginTask = this.service.createTask(text, []);
            this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task: pluginTask });
            await this.service.runSteerCommand(result.steer, options.attachments);
            pluginTask.status = "complete";
            pluginTask.endedAt = new Date().toISOString();
            this.service.emit({ type: "task-end", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task: pluginTask });
            return pluginTask;
          }
          return this.sendMessage(result.steer, options);
        } else {
          const pluginTask = this.service.createTask(text, []);
          this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task: pluginTask });
          const reply = result.reply ?? `plugin ${commandName}: nothing to do (no active turn)`;
          const event: RoomEvent = { id: `system_${pluginTask.id}`, timestamp: new Date().toISOString(), author: "system", text: reply };
          this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
          pluginTask.status = "complete";
          pluginTask.endedAt = new Date().toISOString();
          this.service.emit({ type: "task-end", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task: pluginTask });
          return pluginTask;
        }
      } else {
        const target = await this.service.nativeCommandTarget();
        const agent = this.service.workspace.agents[target];
        // The harness owns its command surface. Never duplicate its skill/template
        // registry here: pass an unclaimed command-shaped token through verbatim
        // whenever the active harness advertises native command handling. Pi then
        // resolves its loaded skills and prompt templates in AgentSession.prompt().
        if (agent && findHarness(harnessIdFor(agent, this.service.workspace))?.capabilities.supportsNativeCommands) {
          command = { type: "message", text };
          options = { ...options, targets: [target], nativeCommand: true };
        } else if (text.trim().split(/\s+/).length > 1) {
          // Not a known command, and no agent can run it as a native command — but
          // it carries content ("/note buy milk", "/deep-research quantum"), so it
          // is the user's MESSAGE, not a typo. Deliver it rather than discard it
          // with an "Unknown command" reply. A user message may never disappear.
          // (A lone contentless "/typo" still falls through to the corrective hint.)
          command = { type: "message", text };
        }
      }
    }
    // Validate routing up-front so unknown-agent errors surface immediately,
    // whether the turn runs now or is queued behind a busy one.
    let targets: string[] = [];
    if (command.type === "message") {
      targets = options.nativeCommand
        ? (options.targets ?? [])
        : (await this.service.isMonadMessage(text, options))
          ? await this.service.monadAuthor()
          : (options.targets ?? (await this.routeTargets(text)));
      for (const target of targets) {
        if (!this.service.workspace.agents[target]) throw new Error(this.service.unknownAgentMessage(target));
      }
    }

    const task = this.service.createTask(text, targets);
    // A human can always call an agent back. Only actual user messages clear
    // this durable suppression; agent dialogue, goals, and WAL replays do not.
    if (command.type === "message" && options.recordUserMessage !== false && !options.fromAgentDialogue) {
      await this.service.reactivateConversation(targets);
    }

    // /steer and /cancel must run WHILE a turn is active — steer injects into
    // the running turn, cancel stops it — so neither queues behind it.
    if (command.type === "steer" || command.type === "cancel") {
      this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
      const reply =
        command.type === "steer" ? await this.service.runSteerCommand(command.text, options.attachments) : await this.service.runCancelCommand();
      const event: RoomEvent = { id: `system_${task.id}`, timestamp: new Date().toISOString(), author: "system", text: reply };
      this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
      task.status = "complete";
      task.endedAt = new Date().toISOString();
      this.service.emit({ type: "task-end", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
      return task;
    }

    // Steer-by-default: while an agent turn is streaming, a plain message aimed
    // at that same agent injects into the RUNNING turn (mid-turn guidance)
    // instead of queuing behind it. Queuing is the explicit opt-in
    // (options.queue, from the Cmd/Ctrl+Enter shortcut) or the fallback when
    // steering can't apply — the message is addressed to a different agent,
    // several agents are running, or the running harness can't inject.
    // Attachments ride along as the uniform breadcrumb lines (the file is
    // already on disk; see renderAttachmentLines), so a pasted screenshot
    // steers exactly like plain text. Uniform: gated on the runtime's
    // supportsSteer, never a harness id.
    let recordedSteerEventId: string | undefined;
    if (
      command.type === "message" &&
      !options.nativeCommand &&
      !options.queue &&
      this.service.activeAgentTurn &&
      this.service.activeAgentTurn.targets.length === 1
    ) {
      const runner = this.service.activeAgentTurn.targets[0];
      const runtime = this.service.runtimes[runner];
      const aimedAtRunner = targets.length > 0 && targets.every((id) => id === runner);
      if (aimedAtRunner && runtime?.capabilities.supportsSteer) {
        const steered = await this.service.steerRunningTurn(runner, text, task, options.attachments, options.human);
        if (steered === true) return task;
        // The turn just ended under us: the guidance is ALREADY committed to
        // the transcript (persist-first). Fall through to the queue with the
        // committed event's id riding the entry, so the drained turn replays
        // it without re-recording and the client shows the committed bubble
        // instead of a queued ghost.
        recordedSteerEventId = steered;
      }
    }

    // Close the settle->drain gap (see `draining`'s doc comment) before
    // reading activeTask below — without this, a message sent in that window
    // would see activeTask already cleared and jump the durable queue ahead
    // of a message that's been waiting far longer. Resolves fast (drain()'s
    // own decision, not a queued command's execution) — never a meaningful
    // stall for the idle, nothing-was-settling case (already-resolved awaits
    // cost a microtask).
    if (this.service.draining) await this.service.draining;

    // Busy? Persist to the durable queue and return — it runs on settle and
    // survives a daemon crash in between.
    if (this.service.activeTask) {
      await this.enqueueTask(task, text, targets, options, recordedSteerEventId);
      this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
      void this.service.emitSnapshot();
      return task;
    }

    // Idle. A command resolves synchronously so callers can read its system
    // reply right after awaiting; message turns start and stream asynchronously.
    if (command.type !== "message") {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.service.activeTask = task;
      this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
      await this.service.runCommand(task, command);
      return task;
    }

    // Durable-first even while idle: the 2026-07-13 append→pendingTurn incident
    // proved a direct start could strand a transcript-only user message.
    await this.enqueueTask(task, text, targets, options, recordedSteerEventId);
    await this.drain();
    if (task.status === "queued") {
      this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
      void this.service.emitSnapshot();
    }
    return task;
  }

  private async enqueueTask(
    task: Task,
    text: string,
    targets: string[],
    options: SendMessageOptions,
    recordedEventId?: string,
  ): Promise<void> {
    const recorded = Boolean(recordedEventId) || options.recordUserMessage === false;
    task.status = "queued";
    if (recorded) task.recorded = true;
    if (options.attachments?.length) task.attachments = options.attachments;
    await this.service.room.enqueue({
      taskId: task.id,
      text,
      targets,
      ...(options.channel === "voice" ? { channel: options.channel } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options.nativeCommand ? { nativeCommand: true } : {}),
      ...(options.pluginMessageTurn ? { pluginMessageTurn: true } : {}),
      ...(recordedEventId ? { eventId: recordedEventId } : {}),
      ...(recorded ? { recorded: true } : {}),
      ...(options.human ? { humanId: options.human.id, humanLabel: options.human.label } : {}),
      queuedAt: task.startedAt,
    });
    this.service.queuedTasks.push(task);
  }

  private startTask(task: Task, text: string, options: SendMessageOptions): void {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.service.activeTask = task;
    this.service.activeAgentTurn = task;
    this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
    void this.service.emitRoomsChanged();

    // Held so cancelActiveTask can await the turn's unwind — the unwind is what
    // commits a streamed partial, and the cancel's settle snapshot must come
    // AFTER that commit or the partial vanishes from the UI until much later.
    this.service.activeTurnUnwind = this.service.runAgentTask(task, text, options)
      .catch((error) => {
        if (this.service.taskCancelled(task)) return;
        this.service.settleTask(task, "error", error);
      })
      .finally(() => {
        this.service.activeTurnUnwind = undefined;
      });
  }

  /** Dispatches the next durably-queued message once the room goes idle.
   * Two-phase hand-off: the entry is PEEKED, not dequeued — it stays in
   * state.json.queue until a successor durable record replaces it (the turn's
   * pendingTurn marker, or a command's persisted reply), so a crash anywhere
   * in between re-drains the message instead of losing it. */
  /** `onDecided`, if given, is invoked the instant the busy/idle question is
   * settled — either a queued item claims `activeTask` or the queue is
   * confirmed empty — so a caller tracking `this.service.draining` (settleTask) can
   * resolve without waiting for a queued COMMAND's full execution below. */
  async drain(onDecided?: () => void): Promise<void> {
    try {
      if (this.service.activeTask) return;
      let next = await this.service.room.peekQueue();
      let droppedStaleGoal = false;
      // Ended agents receive no autonomous follow-up. Preserve any other
      // targets on a multi-agent automatic task, but discard an empty entry.
      while (next && (next.fromAgentDialogue || next.goalStartedAt || next.recorded)) {
        const ended = await this.service.endedConversationTargets(next.targets);
        if (ended.length === 0) break;
        const targets = next.targets.filter((target) => !ended.includes(target));
        if (targets.length > 0) {
          next = { ...next, targets };
          break;
        }
        await this.service.room.spliceQueued(next.taskId);
        this.service.queuedTasks = this.service.queuedTasks.filter((task) => task.id !== next?.taskId);
        droppedStaleGoal = true;
        next = await this.service.room.peekQueue();
      }
      while (next?.goalStartedAt) {
        const goal = (await this.service.room.state()).goal;
        if (goal?.status === "active" && goal.startedAt === next.goalStartedAt) break;
        await this.service.room.spliceQueued(next.taskId);
        this.service.queuedTasks = this.service.queuedTasks.filter((task) => task.id !== next?.taskId);
        droppedStaleGoal = true;
        next = await this.service.room.peekQueue();
      }
      if (droppedStaleGoal) void this.service.emitSnapshot();
      if (!next) return;
      const due = next.notBefore ? Date.parse(next.notBefore) : Number.NaN;
      if (Number.isFinite(due) && due > Date.now()) {
        onDecided?.();
        onDecided = undefined;
        clearTimeout(this.service.authRetryTimer);
        this.service.authRetryTimer = setTimeout(() => {
          this.service.authRetryTimer = undefined;
          void this.drain();
        }, due - Date.now());
        this.service.authRetryTimer.unref?.();
        return;
      }
      const chip = this.service.queuedTasks.find((task) => task.id === next.taskId);
      this.service.queuedTasks = this.service.queuedTasks.filter((task) => task.id !== next.taskId);
      const task = chip ?? this.service.createTask(next.text, next.targets);
      // From this point on, activeTask is set SYNCHRONOUSLY (no intervening
      // await) by both branches below — safe to resolve now, so a
      // sendMessage() that was awaiting `draining` sees the correct busy
      // state the moment it resumes, without blocking on this queued turn's
      // full run (a queued /compact can take a while).
      onDecided?.();
      onDecided = undefined;
      try {
        // Agent-dialogue hand-offs are agent-authored text, never slash commands —
        // skip command parsing (a reply opening with "/" is prose, not /clear). A
        // native command already decided it's a command turn to a pinned target;
        // re-parsing would just "unknown"-error it, so run it as a message too. A
        // command-plugin verb (PluginResult.rewriteAsMessage) was already
        // mutated + rewritten to a message by sendMessage() before it was ever
        // queued — re-parsing it here would re-run that plugin mutation and
        // misroute it.
        const command: RoomCommand =
          next.fromAgentDialogue || next.nativeCommand || next.pluginMessageTurn
            ? { type: "message", text: next.text }
            : parseCommand(next.text);
        if (command.type !== "message") {
          task.status = "running";
          task.startedAt = new Date().toISOString();
          this.service.activeTask = task;
          this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task });
          await this.service.runCommand(task, command);
          // The reply is durable (runCommand persists it) — only now consume the
          // entry. A crash before this line re-runs the command on boot
          // (at-least-once; commands are idempotent-enough, loss is not).
          await this.service.room.spliceQueued(next.taskId);
          return;
        }
        this.startTask(task, next.text, {
          targets: next.targets,
          queued: next,
          ...(next.channel ? { channel: next.channel } : {}),
          ...(next.attachments?.length ? { attachments: next.attachments } : {}),
          ...(next.fromAgentDialogue ? { fromAgentDialogue: true, recordUserMessage: false } : {}),
          ...(next.goalStartedAt ? { goalStartedAt: next.goalStartedAt } : {}),
          ...(next.recorded ? { recordUserMessage: false } : {}),
          ...(next.nativeCommand ? { nativeCommand: true } : {}),
          // Retried prompts are already on the transcript from the original
          // run — never re-record them. `queued: next` above carries retry
          // metadata through to runAgentTask's options.
          ...(next.stallRetried || next.authRetries ? { recordUserMessage: false } : {}),
          ...(next.humanId ? { human: { id: next.humanId, label: next.humanLabel ?? next.humanId } } : {}),
        });
      } catch (error) {
        this.service.settleTask(task, "error", error);
      }
    } finally {
      // Covers the early returns above (activeTask already set, queue empty)
      // — a no-op if the mid-function call already fired.
      onDecided?.();
    }
  }

  private async routeTargets(text: string): Promise<string[]> {
    const route = planMentionRoute(text, Object.keys(this.service.workspace.agents), await this.roomDefaultTarget());
    if (!route.ok) {
      throw new Error(
        `Unknown agent: ${route.unknown.map((id) => `@${id}`).join(", ")}. Available agents: ${Object.keys(this.service.workspace.agents)
          .map((id) => `@${id}`)
          .join(", ")}`,
      );
    }
    return route.targets;
  }

  /** Fallback target for a message with no leading @mention: the room's active
   * agent (the last one addressed here), or the workspace defaultAgent when the
   * room has none yet — or its active agent was since removed. Per-room, so
   * every room remembers who you were last talking to independently. */
  async roomDefaultTarget(): Promise<string> {
    const active = (await this.service.room.state()).activeAgent;
    return active && this.service.workspace.agents[active] ? active : this.service.workspace.config.defaultAgent;
  }

}
