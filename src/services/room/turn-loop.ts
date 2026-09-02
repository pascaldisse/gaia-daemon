import { newId } from "../../core/ids.js";
import type { AgentDef, PendingTurn, RoomEvent, Task } from "../../core/types.js";
import type { ContextDietPolicy } from "../../domain/context-diet.js";
import { newRoomEventId } from "../../domain/rooms.js";
import { effectiveAgentSkills, effectiveAgentTools, effectiveRoleName, resolveAgentRole } from "../../domain/roles.js";
import { contextWindowFor, harnessIdFor } from "../../harness/spec.js";
import { readUserNameSetting } from "../user-name.js";
import type { RoomTurnLoopPort } from "./ports.js";
import { finalizeInterruptedTools, runAgentTurn } from "../turns.js";
import { HOOK_TEXT_CAP } from "../hooks.js";
import { PARTIAL_FLUSH_MS, STALL_NOTICE_THROTTLE_MS, diedWithoutOutput, preservePartialReply, readAmbientWatchdog } from "../room-service.js";
import type { SendMessageOptions } from "../room-service.js";

function isContextDietPolicy(value: unknown): value is ContextDietPolicy {
  return typeof value === "object" && value !== null &&
    "preset" in value && typeof value.preset === "boolean" &&
    "keepAllToolCalls" in value && typeof value.keepAllToolCalls === "boolean" &&
    "fullTurnWindow" in value && typeof value.fullTurnWindow === "number" &&
    "toolTailLines" in value && typeof value.toolTailLines === "number";
}

/** Durable agent-turn execution; queue custody and WAL ordering remain unchanged. */
export class RoomTurnLoop {
  constructor(private readonly service: RoomTurnLoopPort) {}
  async runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    // A native command is already pinned to the active agent — it never fans out
    // through the monad.
    if (!options.nativeCommand && (await this.service.isMonadMessage(text, options))) {
      await this.service.runMonadTask(task, text, options);
      return;
    }

    const channel = options.channel === "voice" ? ("voice" as const) : undefined;
    const attachments = options.attachments?.length ? options.attachments : undefined;
    if (options.recordUserMessage !== false) {
      // A drained queue entry commits under a durably pre-reserved event id so
      // a crash between reserve and append (or append and queue-consume)
      // replays idempotently instead of dropping or doubling the message.
      const queued = options.queued;
      let userEvent: RoomEvent | undefined;
      if (queued?.eventId && (await this.service.room.hasEvent(queued.eventId))) {
        userEvent = undefined; // already on disk from the pre-crash run
      } else {
        let eventId = queued?.eventId;
        if (queued && !eventId) {
          eventId = newRoomEventId();
          await this.service.room.assignQueuedEventId(queued.taskId, eventId);
        }
        userEvent = await this.service.room.addUserMessage(text, task.targets, channel, attachments, eventId, options.human);
      }
      if (userEvent) {
        this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event: userEvent });
        // Auto-named rooms take their display title from their first human
        // message (never from a name dialog) — the Claude Code / Codex pattern.
        // Agent-dialogue turns don't count as the human naming the room.
        if (!options.fromAgentDialogue) await this.service.maybeAutoTitle(text);
      }
      // Authoritative refresh right after the commit: this snapshot has the
      // queued ghost dropped AND the committed user event present, so it
      // reconciles the ghost→committed swap on the client even when this turn
      // was drained behind a settling one whose (earlier) snapshot still showed
      // the ghost. Without it the swap depends on snapshot/room-event ordering.
      void this.service.emitSnapshot();
    }
    // A human message ends any agent-dialogue chain and resets its hop budget.
    if (!options.fromAgentDialogue) this.service.agentDialogueHops = 0;
    // This room is now talking to whoever this turn addresses.
    await this.service.rememberActiveAgent(task.targets);

    const remaining = [...task.targets];
    for (const target of task.targets) {
      if (this.service.taskCancelled(task)) {
        await this.service.room.clearPendingTurn();
        return;
      }
      if (await this.service.isConversationEnded(target)) {
        remaining.shift();
        continue;
      }
      const agent = this.service.workspace.agents[target];
      const runtime = this.service.runtimes[target];
      this.service.startedPetTargets.add(this.service.petTargetKey(task.id, target));
      this.service.emitPetProgress(task, target, "working");
      const state = await this.service.room.state();
      // Generic per-turn-start plugin hook (CommandPlugin.turnStart — e.g.
      // plugins/defaults/dog-mode.mjs expiring its transient /facial marker
      // right at this turn's start, never mid-command).
      await this.service.pluginTurnStart(state);
      // A NEW agent (never spoke here → no cursor) loads the whole back-transcript.
      // An EXISTING agent normally loads only events since its cursor — everything
      // earlier lives in its harness session. When that session is GONE (crash,
      // dropped handle, pruned store) the cursor is a lie: trusting it would start
      // the agent mid-conversation with silent amnesia, so replay from 0 instead.
      // Either full load is gated if large. Skipped on the resumed run
      // (cursorOverride set / bypass) and in voice calls (no modal).
      //
      // A missing session only counts as LOST while the cursor claims context
      // beyond the agent's floor: after a DELIBERATE reset (rewind/sanitize set
      // cursor == floor == the seed base) the capped cursor IS the intended
      // seed — replaying it is by design, not amnesia, so no gate fires.
      const isNewAgent = state.agentCursors[target] === undefined;
      const sessionLost =
        !isNewAgent &&
        (state.agentCursors[target] ?? 0) > (state.contextFloors?.[target] ?? 0) &&
        options.cursorOverride === undefined &&
        (runtime.hasDurableSession?.(this.service.roomId) ?? true) === false;
      // Durable compaction: if this agent explicitly /compacted (floor > 0) and its
      // harness session is now LOST, replay [stored summary + tail after floor]
      // instead of the full raw transcript — so the compaction survives the session
      // loss instead of silently reverting to everything-from-0. The stored summary
      // is trusted only while its floorIdx still equals the live floor (a rewind
      // that moved the floor auto-invalidates it, and clears it besides).
      const floor = state.contextFloors?.[target] ?? 0;
      const storedCompaction = sessionLost && floor > 0 ? await this.service.room.readCompaction(target) : undefined;
      const replaySummary = storedCompaction && storedCompaction.floorIdx === floor ? storedCompaction.summary : undefined;
      const desiredCursor =
        options.cursorOverride ?? (replaySummary !== undefined ? floor : sessionLost ? 0 : (state.agentCursors[target] ?? 0));
      let page = await this.service.room.eventsFrom(desiredCursor);
      // Fail-safe for a cursor that points PAST the end of the transcript: the
      // file shrank under it (an out-of-band rewrite, a restored backup, an
      // older transcript copied in). Read from there and the agent silently
      // sees an empty room forever, with no error anywhere. Replay from 0 and
      // reset the stored cursor instead — over-replay is recoverable, amnesia
      // is not. (nextCursor is the physical line count.)
      // Past EOF is always corruption. An EMPTY page at cursor == EOF is only
      // corruption when THIS turn recorded a user message: that line must be
      // visible, so seeing nothing means the line space the cursor was recorded
      // against is gone. Continuation turns record nothing by design (goal
      // continuations, agent hand-offs, resume — recordUserMessage:false) and
      // legitimately start at EOF with zero new events; flagging those replayed
      // the whole history and reset the cursor to 0 permanently. An explicit
      // cursorOverride is a deliberate seed and is never second-guessed.
      const staleCursor =
        options.cursorOverride === undefined &&
        desiredCursor > 0 &&
        (desiredCursor > page.nextCursor ||
          (options.recordUserMessage !== false && page.nextCursor <= desiredCursor));
      const cursor = staleCursor ? 0 : desiredCursor;
      if (cursor !== desiredCursor) {
        page = await this.service.room.eventsFrom(cursor);
        await this.service.room.updateState((current) => {
          current.agentCursors[target] = 0;
        });
      }
      const rawEvents = page.events;
      // System events (slash-command replies) are persisted for the human UI
      // but are room chrome, not conversation — keep them out of what the agent
      // sees so /help, /recall, /compact results never pollute its context.
      // Cursor space still counts their lines, so paging stays aligned with
      // the on-disk transcript.
      const events = rawEvents.filter((event) => event.author !== "system");
      // NO AUTOMATIC TRUNCATION. A new agent or a session-lost replay ALWAYS
      // loads the full context (from cursor 0 / the agent's floor). The context
      // is never silently shrunk, windowed, or summarized behind the user's
      // back — the only thing that ever reduces context is an explicit /compact
      // the user types. (The old size-based context gate that forced a
      // last-N/compact choice on big first loads is gone by design.)
      const activeRoleName = effectiveRoleName(state.activeRoles, agent);
      const activeRole = activeRoleName ? await resolveAgentRole(agent, activeRoleName) : undefined;
      if (activeRoleName && !activeRole) {
        this.service.emit({
          type: "task-error",
          workspaceId: this.service.workspaceId,
          roomId: this.service.roomId,
          task,
          error: `Active role not found for @${agent.id}: ${activeRoleName}`,
        });
      }

      // WAL step 1: reserve the reply's event id and persist the in-flight
      // marker BEFORE streaming — an interruption leaves a resumable record.
      // The same atomic write consumes the drained queue entry (if any): the
      // message's durable custody moves queue → WAL with no gap. Idempotent
      // across the multi-target loop (only the first write finds the entry).
      const eventId = newRoomEventId();
      await this.service.room.markPendingTurn(
        {
          id: task.id,
          eventId,
          prompt: text,
          ...(attachments ? { attachments } : {}),
          targets: [...remaining],
          agentId: target,
          partialReply: "",
          ...(channel ? { channel } : {}),
          ...(options.goalStartedAt ? { goalStartedAt: options.goalStartedAt } : {}),
          startedAt: new Date().toISOString(),
        },
        options.queued ? { consumeQueuedTaskId: options.queued.taskId } : undefined,
      );
      // Seed the live-turn mirror so a mid-turn (re)subscribe renders it at once.
      this.service.liveTurn = { eventId, taskId: task.id, agentId: target, startedAt: new Date().toISOString(), text: "", details: {} };
      let lastFlush = 0;
      let lastFlushedReply = "";
      // Throttle for the visible "upstream stall" system line — local to THIS
      // turn, so a fresh turn always gets to say it's stuck at least once.
      let lastStallNoticeAt = 0;

      // Auto-recall never blocks or fails a turn: the hook returns "" on any
      // miss and room-service treats "" as absent. A context-gate "compact"
      // resume overrides it with the room summary for this one turn. The
      // active-context ref lets recall drop self-matches from THIS room while
      // keeping compacted-away history reachable.
      // recallOverride (a context-gate/session-lost resume summary of THIS room's
      // own transcript) still applies in an incognito room; only the long-term
      // memory auto-recall is suppressed — nothing about this room reaches the
      // agent's context from the memory subsystem.
      // On a durable-compaction replay, the stored summary IS the pre-floor
      // context — feed it as a labelled block (the raw messages below the floor
      // stay recall-reachable), alongside any auto-recall for this turn.
      const compactionBlock =
        replaySummary !== undefined
          ? `The earlier part of this conversation was compacted. Summary of everything before the recent messages (the raw messages remain reachable via recall):\n\n${replaySummary}`
          : undefined;
      const autoRecall = options.recallOverride?.trim()
        ? options.recallOverride
        : this.service.incognito
          ? undefined
          : (await this.service.options.memory?.autoRecallBlock(target, text, {
              roomId: this.service.roomId,
              floorIdx: floor,
            })) || undefined;
      const recall = compactionBlock ? [compactionBlock, autoRecall].filter(Boolean).join("\n\n") : autoRecall;

      this.service.fireHooks("preTurn", { agentId: target, message: text.slice(0, HOOK_TEXT_CAP), ...(channel ? { channel } : {}) });

      // Role watchdog — event-driven enforcement; a role may declare a
      // tool-call tripwire (frontmatter `watchdog:`) and the daemon steers a
      // corrective message into the running turn when it crosses. Plain
      // watchdog fires once; `repeat: true` re-fires every `toolCalls` calls
      // for the rest of the turn. Zero cost when the agent behaves.
      let watchdogToolCalls = 0;
      let watchdogFired = false;
      let watchdogFiredAt = 0;

      // Ambient watchdog — a generic, plugin-driven sibling of the role one:
      // ANY local command-plugin (e.g. /ultrawhip) can drop a small JSON file
      // at ambientWatchdogPath() to make every running turn, for every agent,
      // get an auto-repeating steer every N tool calls — no role assignment,
      // no per-agent config, just a command toggling a file. Re-read per
      // tool-start (cheap: one existsSync + a small readFileSync) so toggling
      // it takes effect on the very next tool call, mid-turn.
      let ambientToolCalls = 0;
      let ambientFiredAt = 0;

      const userName = await readUserNameSetting();
      const pluginContext = await this.service.pluginPrompt(state, target);
      // Context-diet (09-MEMORY-CONTEXT): resolved fresh every turn (two small
      // JSON reads) so a /diet toggle mid-conversation applies on the very
      // next turn, no session rebuild. `preset:false` (the default) renders
      // renderRoomTranscript IDENTICALLY to omitting dietPolicy — IRON, zero
      // cost/behavior change for every room that never opts in.
      const resolvedDietPolicy = await this.service.dietPolicyStore.effective(this.service.roomId);
      const dietPolicy = isContextDietPolicy(resolvedDietPolicy) ? resolvedDietPolicy : undefined;

      let turn: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        turn = await runAgentTurn({
          runtime,
          input: {
            roomId: this.service.roomId,
            message: text,
            ...(attachments ? { attachments } : {}),
            transcript: events,
            activeRole,
            tools: effectiveAgentTools(agent, activeRole),
            skills: effectiveAgentSkills(agent, activeRole),
            channel: options.channel,
            thinking: options.thinking ?? state.thinkingOverrides[target],
            ...(state.thinkingLevel ? { protocolThinkingLevel: state.thinkingLevel } : {}),
            recall,
            ...(pluginContext ? { pluginContext } : {}),
            ...(options.nativeCommand ? { nativeCommand: true } : {}),
            ...(userName ? { userName } : {}),
            ...(dietPolicy?.preset ? { dietPolicy } : {}),
          },
          isCancelled: () => this.service.taskCancelled(task),
          onEvent: (event) => {
            if (event.type === "tool-start") {
              watchdogToolCalls += 1;
              const watchdog = activeRole?.watchdog;
              const dueAgain = watchdog?.repeat && watchdogToolCalls - watchdogFiredAt >= watchdog.toolCalls;
              if (watchdog && ((!watchdogFired && watchdogToolCalls >= watchdog.toolCalls) || dueAgain)) {
                watchdogFired = true;
                watchdogFiredAt = watchdogToolCalls;
                const pick = watchdog.messages?.length
                  ? watchdog.messages[Math.floor(Math.random() * watchdog.messages.length)]
                  : watchdog.message;
                void this.service.fireWatchdogSteer(target, runtime, pick);
              }
              ambientToolCalls += 1;
              const ambient = readAmbientWatchdog(this.service.roomId);
              if (ambient && ambientToolCalls - ambientFiredAt >= ambient.toolCalls) {
                ambientFiredAt = ambientToolCalls;
                const ambientPick = ambient.messages[Math.floor(Math.random() * ambient.messages.length)];
                void this.service.fireWatchdogSteer(target, runtime, ambientPick);
              }
            }
            if (event.type === "model-fallback") {
              this.service.modelFallbacks[target] = { from: event.fromModel, to: event.toModel, reason: event.reason };
            }
            if (event.type === "background-task") {
              void this.service.recordBackgroundTask(target, event).catch(() => {});
            }
            if (event.type === "notice") {
              // Visible, throttled system line — never reply text (toUiEvent
              // already drops `notice` as a no-op UI transport event above).
              const now = Date.now();
              if (now - lastStallNoticeAt > STALL_NOTICE_THROTTLE_MS) {
                lastStallNoticeAt = now;
                const noticeEvent: RoomEvent = {
                  id: newId("system_stall"),
                  timestamp: new Date().toISOString(),
                  author: "system",
                  text: `⚠ upstream stall (@${target}): ${event.text} — harness retrying`,
                };
                void this.service.room
                  .appendEvent(noticeEvent)
                  .then(() => this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event: noticeEvent }))
                  .catch(() => {});
              }
            }
            if (event.type === "context-usage") {
              // The window (maxTokens) only rides the turn-end event; keep the
              // last-known one, else fall back to the harness's a-priori window,
              // so mid-turn updates (and the first turn after a restart, when no
              // window has been learned yet) still render a live % chip instead
              // of a raw token count. The window is spec data, not a branch.
              const aprioriWindow = contextWindowFor(harnessIdFor(agent, this.service.workspace), agent.model?.name);
              const maxTokens = event.maxTokens ?? this.service.contextUsage[target]?.maxTokens ?? aprioriWindow;
              const usage = { usedTokens: event.usedTokens, ...(maxTokens ? { maxTokens } : {}) };
              this.service.contextUsage[target] = usage;
              // Persist durably (best-effort) so the chip survives a restart.
              void this.service.room
                .updateState((current) => {
                  current.contextUsage = { ...(current.contextUsage ?? {}), [target]: usage };
                })
                .catch(() => {});
            }
            this.service.applyLiveTurn(eventId, event);
            // Native-pet progress comes exclusively from the uniform AgentEvent
            // stream. No harness id is inspected: every present/future harness
            // gets Thinking/tool/Working with the same mapping.
            switch (event.type) {
              case "thinking-start":
              case "thinking-delta":
                this.service.emitPetProgress(task, target, "thinking");
                break;
              case "tool-start":
              case "tool-update":
                this.service.emitPetProgress(task, target, "tool", event.toolName);
                break;
              case "thinking-end":
              case "tool-end":
              case "text-delta":
                this.service.emitPetProgress(task, target, "working");
                break;
            }
            const uiEvent = this.service.toUiEvent(task.id, agent.id, eventId, event);
            if (uiEvent) this.service.emit(uiEvent);
            if (event.type === "tool-end") {
              this.service.fireHooks("toolUse", { agentId: target, toolName: event.toolName, isError: event.isError });
            }
          },
          onProgress: async (reply, event) => {
            if (reply === lastFlushedReply) return;
            // Text deltas are throttled; any OTHER event (a tool starting, a
            // thinking block) flushes immediately — it marks a block boundary,
            // and the prose tail must not sit unpersisted through a long tool
            // run (the flush froze at "If you want something r" while tools
            // streamed for a minute — that stale flush was all a stop kept).
            const now = Date.now();
            if (event.type === "text-delta" && now - lastFlush < PARTIAL_FLUSH_MS) return;
            lastFlush = now;
            lastFlushedReply = reply;
            await this.service.room.flushPartialReply(reply);
          },
        });
      } catch (error) {
        // Last-resort net: runAgentTurn no longer throws for a dying stream
        // (it returns the accumulator with `error` set) — reaching here means
        // setup/progress persistence failed around the stream. Preserve any
        // WAL-flushed text through the SAME reserved-id commit path and make
        // the abnormal end visible; a blank turn gets a loud durable failure.
        const pending = (await this.service.room.state()).pendingTurn;
        const partial = pending?.partialReply ?? "";
        this.service.liveTurn = undefined;
        if (partial.trim()) await this.service.commitReply(target, eventId, preservePartialReply(partial, error), {}, channel);
        else {
          await this.service.room.clearPendingTurn();
          await this.service.appendTurnFailure(target, diedWithoutOutput(error));
        }
        await this.service.maybeRequeueStall(remaining, target, text, error, partial, channel, attachments, options) ||
          await this.service.maybeRequeueAuth(remaining, target, text, error, partial, channel, attachments, options);
        await this.service.captureEpisode(target, text, partial, "error", {}, channel);
        this.service.settlePetTarget(task, target, "failed");
        throw error;
      }

      // A turn that ran clean on the configured model retires the standing
      // fallback warning; one that fell back (re)arms it.
      if (!turn.details.modelFallback) delete this.service.modelFallbacks[target];

      // Cancelled, failed, or completed: ALL commit what was produced. A user
      // stop lands as a stream death (abort → turn-error → the runtime stream
      // throws), so `turn.error` with the cancel flag set IS the normal stop
      // shape — never a reason to drop the accumulator. Every abnormal teardown
      // gets an explicit visible outcome: output commits under the reserved id
      // with a preservation notice; no output commits a loud system failure.
      const cancelled = turn.cancelled || this.service.taskCancelled(task);
      // The end-conversation tool deliberately aborts the runner after its
      // visible farewell is durable. That abort is success, never a failure.
      const endedConversation = await this.service.isConversationEnded(target);
      const failed = turn.error !== undefined && !cancelled && !endedConversation;
      // A user stop is a stop, not a malfunction: never surface the raw harness death (SIGTERM/exit 143) a cancel provokes.
      const abnormalReason = cancelled ? new Error("stopped by user") : endedConversation ? undefined : turn.error;
      if (abnormalReason !== undefined) finalizeInterruptedTools(turn.details);
      const partialReply = turn.reply.trim();
      // An interrupted turn that produced tools/thinking but no prose yet still
      // commits — stopping an agent mid-tool-phase must not vanish the work the
      // user watched happen. (A CLEAN empty turn stays uncommitted as before.)
      const interruptedProgress = abnormalReason !== undefined && Boolean(turn.details.tools?.length || turn.details.thinking);
      const producedOutput = Boolean(partialReply || interruptedProgress);
      const committedReply = abnormalReason !== undefined && producedOutput
        ? preservePartialReply(partialReply, abnormalReason)
        : partialReply;
      // Multi-target hand-off: this target's commit (or clear) must not open a
      // window where the remaining targets' owed turns exist in memory only —
      // the SAME atomic state write that retires this target's marker installs
      // the next target's (no eventId: a boot resume reruns it via sendMessage).
      // A cancel or failure deliberately ends the whole task: no hand-off.
      const rest = remaining.slice(1);
      const nextPending: PendingTurn | undefined =
        !cancelled && !failed && rest.length > 0
          ? {
              id: task.id,
              prompt: text,
              ...(attachments ? { attachments } : {}),
              targets: rest,
              agentId: rest[0],
              partialReply: "",
              ...(channel ? { channel } : {}),
              ...(options.goalStartedAt ? { goalStartedAt: options.goalStartedAt } : {}),
              startedAt: new Date().toISOString(),
            }
          : undefined;
      // The committed room-event now carries the reply; the live mirror is spent.
      this.service.liveTurn = undefined;
      // Generic command-plugin render/post-layer enforcement (see
      // services/plugins.ts CommandPlugin.renderCap, e.g.
      // plugins/defaults/dog-mode.mjs): the cap is resolved here but NEVER
      // applied to what gets stored — commitReply persists committedReply
      // (the agent's FULL real output) always, and stores this cap alongside
      // it (AgentRoomEvent.renderCap) so every DISPLAY surface (live emit,
      // snapshot fetch, read-aloud) can derive the shown text on demand via
      // domain/render-cap.ts#displayEventText. ROOT-CAUSE FIX (Pascal,
      // 2026-08-23): the old code truncated BEFORE persisting, which silently
      // destroyed real replies forever the moment a room was collared —
      // violates NOTHING IS EVER LOST. captureEpisode/hooks/agent-dialogue
      // below already read the RAW partialReply, so this fix only changes
      // what commitReply is handed, not their inputs.
      const renderCap = producedOutput ? await this.service.pluginRenderCap(state) : undefined;
      if (producedOutput) await this.service.commitReply(target, eventId, committedReply, turn.details, channel, nextPending, renderCap);
      else if (nextPending) await this.service.room.markPendingTurn(nextPending);
      else await this.service.room.clearPendingTurn();
      if (abnormalReason !== undefined && !producedOutput) {
        if (cancelled) await this.service.appendTurnStopped(target);
        else await this.service.appendTurnFailure(target, diedWithoutOutput(abnormalReason));
      }

      if (failed) {
        // Genuine mid-stream failure (not a user stop): the preservation notice
        // or no-output failure is durable; surface the original error so the
        // task settles as error, retaining the existing retry policy.
        await this.service.maybeRequeueStall(remaining, target, text, turn.error, partialReply, channel, attachments, options) ||
          await this.service.maybeRequeueAuth(remaining, target, text, turn.error, partialReply, channel, attachments, options);
        await this.service.captureEpisode(target, text, partialReply, "error", turn.details, channel);
        this.service.settlePetTarget(task, target, "failed");
        throw turn.error;
      }

      if (producedOutput) await this.service.captureEpisode(target, text, partialReply, cancelled ? "cancelled" : "complete", turn.details, channel);
      this.service.fireHooks("postTurn", {
        agentId: target,
        reply: partialReply.slice(0, HOOK_TEXT_CAP),
        outcome: cancelled ? "cancelled" : "complete",
        tools: [...new Set((turn.details.tools ?? []).map((tool) => tool.toolName))],
      });

      if (cancelled) {
        this.service.settlePetTarget(task, target, "failed");
        return;
      }
      if (endedConversation) {
        this.service.settlePetTarget(task, target, "done");
        return;
      }
      this.service.settlePetTarget(task, target, "done");
      remaining.shift();
      // Let another agent this reply @mentions pick it up (room toggle + cap).
      if (partialReply) await this.service.maybeDispatchAgentDialogue(target, partialReply);
      // Goal continuation runs ONLY here: past the failure/cancel returns, so a
      // stream error or a stop never counts as goal progress (and never loops).
      if (partialReply && options.goalStartedAt) await this.service.maybeContinueGoal(target, partialReply, options.goalStartedAt);
    }

    if (!this.service.taskCancelled(task)) this.service.settleTask(task, "complete");
  }

  /** The ctx chip's usage figure for the snapshot. Live usage wins, but the
   * window size (maxTokens) is only learned from a clean turn-end `result`; a
   * fresh agent, a room whose turns were all steered/cancelled before a result,
   * or a post-/compact entry may have usedTokens with no window. Fall back to the
   * harness's a-priori context window so the chip renders a % instead of a raw
   * token count. Uniform across harnesses — the window is spec data, not a branch. */
  contextFor(agent: AgentDef): { usedTokens: number; maxTokens?: number } | undefined {
    const live = this.service.contextUsage[agent.id];
    if (!live || live.maxTokens) return live;
    const window = contextWindowFor(harnessIdFor(agent, this.service.workspace), agent.model?.name);
    return window ? { usedTokens: live.usedTokens, maxTokens: window } : live;
  }

}
