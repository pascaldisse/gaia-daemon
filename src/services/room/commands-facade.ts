import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { attachmentMime, sanitizeAttachmentName } from "../../core/attachments.js";
import { Bus } from "../../core/bus.js";
import { newId } from "../../core/ids.js";
import { readJson, writeJsonAtomic } from "../../core/store.js";
import { globalPaths, workspacePaths } from "../../core/paths.js";
import { sleep } from "../../core/retry.js";
import { GOAL_COMPLETE_SIGNAL } from "../../core/types.js";
import type { SanitizeProposal, SanitizeStatus } from "../../core/types.js";
import type {
  AgentDef,
  AgentEvent,
  AgentModelConfig,
  AgentStatus,
  BackgroundTask,
  CompactProgress,
  CompactProgressUpdate,
  CompactResult,
  ContextGatePending,
  EventDetails,
  LiveTurn,
  MessageAttachment,
  ModelFallback,
  PendingTurn,
  PetProgressStatus,
  QueuedMessage,
  RoomEvent,
  RoomEventKind,
  RoomGoal,
  SlashCommandDefinition,
  Snapshot,
  Task,
  UiEvent,
  Workspace,
} from "../../core/types.js";
import { DEFAULTS, DEFAULT_CONTEXT_WARN_TOKENS } from "../../core/config.js";
import { displayEventText, type RenderCap } from "../../domain/render-cap.js";
import { estimateTokens } from "../../core/tokens.js";
import type { ResumeEpoch } from "../resume-epoch.js";
import { deriveRoomTitle, isAutoRoomId, newRoomEventId, normalizeRoomState, normalizeRoomTitle, RoomHandle } from "../../domain/rooms.js";
import { DEFAULT_PET_NAME, listWorkspacePetBindings, loadPet } from "../../domain/pets.js";
import { resolveRoomWorkDir } from "../../domain/worktree.js";
import { effectiveAgentSkills, effectiveAgentTools, effectiveRoleName, listAgentRoles, resolveAgentRole } from "../../domain/roles.js";
import { resolveSkillRefs } from "../../domain/skills.js";
import type { MemoryStore, MemoryAction, MemoryMutationResult } from "../../domain/memory.js";
import { formatMemoryHits, type ActiveContextRef, type MemorySearchHit } from "../../domain/workspace-index.js";
import type { AgentRuntime, ContextDietView, HarnessHost } from "../../harness/spec.js";
import { capabilitiesFor, contextWindowFor, findHarness, harnessIdFor, nativeCommandsFor, usageAccountFor } from "../../harness/spec.js";
import { readOptional, renderAttachmentLines, renderRoomTranscript } from "../../harness/prompt.js";
import { readUserNameSetting } from "../user-name.js";
import { HELP_TEXT, SLASH_COMMANDS, hasExplicitMention, mentionedAgents, parseCommand, planMentionRoute, validateThinkingLevel, type SlashCommand } from "../commands.js";
import { loadCommandPlugins, pluginStateKey, type CommandPlugin, type PluginContext, type PluginPanel, type PluginResult } from "../plugins.js";
import { SANITIZE_REVIEWER_ID, buildSanitizePrompt, parseSanitizeProposal, type SanitizeContext } from "../sanitize.js";
import { applyEventToDetails, finalizeInterruptedTools, runAgentTurn } from "../turns.js";
import { ContextPolicyStore } from "../context-policy-store.js";
import { DEFAULT_CONTEXT_DIET_POLICY, type ContextDietOverrides } from "../../domain/context-diet.js";
import type { EpisodeCapture } from "../memory-service.js";
import { formatDreamProposal } from "../consolidate.js";
import type { ConsolidateLlm, ConsolidateResult } from "../consolidate.js";
import { allowSummonForTurn, effectiveTrust, type SummonHost, type SummonResultDelivery } from "../summons.js";
import { HOOK_TEXT_CAP, runHooks, type HookEvent } from "../hooks.js";
import { MonadEngine } from "../monad.js";
import { activateSetup, deactivateMonad, discoverSetups } from "../setups.js";
import { sdkThinkingLevels } from "../hints.js";
import { createAgentRuntime } from "../../harness/host.js";
import { configuredModelLabel } from "../../harness/model-label.js";
import { resolveSandboxPolicy } from "../../harness/sandbox/spec.js";
import { sttEngineIds } from "../transcribe.js";
import * as contextGate from "../room/context-gate.js";
import { RoomFork } from "../room/fork.js";
import { RoomTurnLoop } from "../room/turn-loop.js";
import { installRoomUi, RoomUiMixin } from "../room/ui.js";
import { installRoomSnapshot, RoomSnapshotMixin } from "../room/snapshot.js";
export { readAmbientWatchdog, scanRoomActivity } from "../room/snapshot.js";
import { readVoiceSettings } from "../voice.js";
import type { RoomCommandsFacadePort } from "./ports.js";

const RECALL_COMMAND_LIMIT = 8;
const SANITIZE_REVIEW_CHAR_BUDGET = 160_000;
const PERSONA_CONTEXT_CAP = 16_000;
type CommandReply = string | { text: string; kind?: RoomEventKind; author?: string };
type RoomCommand = SlashCommand;
export class RoomCommandsMixin {
  /** A watchdog (role or ambient) firing mid-turn: same persist-then-inject
   * shape as runSteerCommand below, just without its command-reply return
   * value — a watchdog fires from inside an onEvent callback, not a command.
   * Without this it only ever reached the runtime directly (never committed,
   * never emitted), so it worked for the agent but was invisible in the room. */
  async fireWatchdogSteer(target: string, runtime: AgentRuntime, message: string): Promise<void> {
    try {
      const event = await this.room.addUserMessage(message, [target]);
      this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
      const ok = (await runtime.steer?.(this.roomId, message)) ?? false;
      if (ok) runtime.injectEvent?.({ type: "steered", eventId: event.id });
    } catch {
      // A watchdog nudge is best-effort — never take the turn down over it.
    }
  }

  /** /steer: inject guidance into the RUNNING turn (capability-gated data —
   * pi session.steer, codex turn/steer, claude stdin stream-json). The guidance is
   * recorded as a user event for history, but the running harness already
   * received it, and the commit cursor advances past it — so it is never
   * replayed as fresh context. */
  async runSteerCommand(text?: string, attachments?: MessageAttachment[]): Promise<string> {
    const guidance = text?.trim();
    if (!guidance) return "Usage: /steer <guidance for the running turn>";
    const task = this.activeTask;
    const target = task?.targets.find((candidate) => this.runtimes[candidate]);
    if (!task || !target) return "No agent turn is running — just send a normal message.";
    const runtime = this.runtimes[target];
    if (!runtime.capabilities.supportsSteer) return `@${target}'s harness does not support mid-turn steering. Cancel and resend instead.`;
    // Same breadcrumb-lines + attachments pairing as steerRunningTurn: the
    // event carries the plain guidance (attachments ride its own field for
    // the UI gallery), the runtime gets the breadcrumb text AND the actual
    // attachment bytes so an image lands for real, not just as a path string.
    const event = await this.room.addUserMessage(guidance, [target], undefined, attachments);
    this.emit({ type: "room-event", workspaceId: this.workspaceId, roomId: this.roomId, event });
    const steerText = attachments?.length ? `${guidance}\n\n${renderAttachmentLines(attachments)}` : guidance;
    const ok = (await runtime.steer?.(this.roomId, steerText, attachments)) ?? false;
    // Same stream-position marker as steer-by-default (see steerRunningTurn).
    if (ok) runtime.injectEvent?.({ type: "steered", eventId: event.id });
    return ok ? `Steering @${target}'s running turn.` : `Could not steer @${target} — the turn may have just finished.`;
  }

  /** Dedupes the loaded plugin map's VALUES — a plugin owning several command
   * names (services/plugins.ts CommandPlugin.command as an array) is the SAME
   * object under each of its keys, and every hook below (panel/prompt/
   * renderCap/turnStart) must run ONCE per plugin, not once per alias. */
  async distinctPlugins(): Promise<CommandPlugin[]> {
    return [...new Set((await this.pluginsPromise).values())];
  }

  /** Runs a local command-plugin's .run(), tolerating a thrown/rejected plugin
   * the same way loadCommandPlugins tolerates a bad module at load time —
   * never crashes the caller. See services/plugins.ts for the contract.
   * `command`, when given, is the specific command name that invoked `run()`
   * (PluginContext.command) — relevant only for a plugin owning several. */
  pluginContext(plugin: CommandPlugin, state: Awaited<ReturnType<RoomHandle["state"]>>, command?: string): PluginContext {
    return {
      homedir: homedir(),
      roomId: this.roomId,
      agentId: state.activeAgent ?? this.workspace.config.defaultAgent,
      workspaceRoot: this.workspace.rootDir,
      state: state.pluginState?.[pluginStateKey(plugin)],
      agents: Object.values(this.workspace.agents).map((agent) => ({ id: agent.id, displayName: agent.displayName, icon: agent.icon })),
      ...(command ? { command } : {}),
    };
  }

  async runPlugin(plugin: CommandPlugin, args: string[], command?: string): Promise<PluginResult> {
    try {
      const state = await this.room.state();
      const result = (await plugin.run(args, this.pluginContext(plugin, state, command))) ?? {};
      if (result.state || (result.activeAgent && this.workspace.agents[result.activeAgent])) {
        await this.room.updateState((next) => {
          if (result.state) {
            next.pluginState ??= {};
            next.pluginState[pluginStateKey(plugin)] = result.state;
          }
          if (result.activeAgent && this.workspace.agents[result.activeAgent]) next.activeAgent = result.activeAgent;
        });
        await this.emitSnapshot();
      }
      return result;
    } catch (error) {
      return { reply: `plugin ${command ?? pluginStateKey(plugin)}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Generic API/UI bridge: plugin action args use the exact same durable run
   * path as a slash command, so extensions never write room state themselves. */
  async runPluginAction(command: string, args: string[]): Promise<string> {
    await this.init();
    const plugin = (await this.pluginsPromise).get(command);
    if (!plugin) throw new Error(`Unknown plugin: ${command}`);
    return (await this.runPlugin(plugin, args, command)).reply ?? "";
  }

  async pluginPanels(state: Awaited<ReturnType<RoomHandle["state"]>>): Promise<Record<string, PluginPanel> | undefined> {
    const panels: Record<string, PluginPanel> = {};
    for (const plugin of await this.distinctPlugins()) {
      if (!plugin.panel) continue;
      const key = pluginStateKey(plugin);
      try {
        const panel = await plugin.panel(this.pluginContext(plugin, state));
        if (panel) panels[key] = panel;
      } catch (error) {
        console.warn(`[plugins] panel ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return Object.keys(panels).length ? panels : undefined;
  }

  async pluginPrompt(state: Awaited<ReturnType<RoomHandle["state"]>>, agentId: string): Promise<string | undefined> {
    const blocks: string[] = [];
    for (const plugin of await this.distinctPlugins()) {
      if (!plugin.prompt) continue;
      try {
        const block = await plugin.prompt({ ...this.pluginContext(plugin, state), agentId });
        if (block?.trim()) blocks.push(block.trim());
      } catch (error) {
        console.warn(`[plugins] prompt ${pluginStateKey(plugin)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return blocks.length ? blocks.join("\n\n") : undefined;
  }

  /** Generic display-time render cap (services/plugins.ts CommandPlugin.
   * renderCap) resolved ONCE per commit turn — see #commitReply. Returns the
   * FIRST plugin-supplied cap, in load order; today only one plugin
   * (plugins/defaults/dog-mode.mjs) ever defines this hook. */
  async pluginRenderCap(state: Awaited<ReturnType<RoomHandle["state"]>>): Promise<RenderCap | undefined> {
    for (const plugin of await this.distinctPlugins()) {
      if (!plugin.renderCap) continue;
      try {
        const cap = await plugin.renderCap(this.pluginContext(plugin, state));
        if (cap) return cap;
      } catch (error) {
        console.warn(`[plugins] renderCap ${pluginStateKey(plugin)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return undefined;
  }

  /** Generic per-turn-start hook (services/plugins.ts CommandPlugin.
   * turnStart) — called once per target right before its turn runs (see
   * #runAgentTask), letting a plugin expire a transient flag in its own state
   * (e.g. plugins/defaults/dog-mode.mjs's /facial marker). A returned object
   * REPLACES that plugin's persisted state wholesale; `state` (the live
   * snapshot this call read from) is updated in place too, so the REST of
   * this same turn sees the fresh value without a second room.state() read. */
  async pluginTurnStart(state: Awaited<ReturnType<RoomHandle["state"]>>): Promise<void> {
    const updates: Record<string, Record<string, unknown>> = {};
    for (const plugin of await this.distinctPlugins()) {
      if (!plugin.turnStart) continue;
      const key = pluginStateKey(plugin);
      try {
        const next = await plugin.turnStart(this.pluginContext(plugin, state));
        if (next !== undefined) updates[key] = next;
      } catch (error) {
        console.warn(`[plugins] turnStart ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (Object.keys(updates).length === 0) return;
    await this.room.updateState((current) => {
      current.pluginState = { ...(current.pluginState ?? {}), ...updates };
    });
    state.pluginState = { ...(state.pluginState ?? {}), ...updates };
  }

  /** Idle-path fallback for an unrecognized /command: the sendMessage seam
   * (see the `command.type === "unknown"` branch there) already handles the
   * live case with full args and mid-turn steering; this one only runs when an
   * unknown command reaches the COMMANDS registry directly (e.g. replayed off
   * the durable queue), so no original arg text survives and no steer applies —
   * just a bare run + reply. */
  async runUnknownCommand(command: Extract<RoomCommand, { type: "unknown" }>): Promise<string> {
    const plugin = (await this.pluginsPromise).get(command.command);
    if (!plugin) return `Unknown command: /${command.command}. Try /help.`;
    const result = await this.runPlugin(plugin, [], command.command);
    return result.reply ?? `plugin ${command.command}: nothing to do (no active turn)`;
  }

  /** /compact: native harness compaction; --edit adds Pi's review/apply
   * variant behind a capability flag, never a harness-id branch. */
  async runCompactCommand(agent?: string, edit?: boolean | string): Promise<CommandReply> {
    const target = agent ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    const runtime = this.runtimes[target];
    if (edit !== undefined) {
      if (!runtime.capabilities.supportsCompactEdit || !runtime.compactDraft || !runtime.compactApply) {
        return `@${target}'s harness has no native editable session compaction.`;
      }
    } else if (!runtime.capabilities.supportsCompact || !runtime.compact) {
      return `@${target}'s harness has no native session compaction.`;
    }
    // `activeTask` here is the /compact command's own task; only a real
    // streaming agent turn should block compaction.
    if (this.activeAgentTurn) return "A turn is running — /cancel it first, or wait for it to finish.";
    this.compactingAgents.add(target);
    const startedAt = Date.now();
    const usedTokens = this.contextUsage[target]?.usedTokens;
    this.compactProgress.set(target, { startedAt, ...(usedTokens ? { contextTokens: usedTokens } : {}) });
    this.lastCompactEmit = startedAt;
    await this.emitSnapshot();
    const progress = (update: CompactProgressUpdate) => {
      const prev = this.compactProgress.get(target);
      if (!prev) return;
      this.compactProgress.set(target, { ...prev, ...update });
      const now = Date.now();
      if (now - this.lastCompactEmit < 500) return;
      this.lastCompactEmit = now;
      void this.emitSnapshot();
    };
    try {
      if (edit === true) {
        const draft = await runtime.compactDraft!(this.roomId);
        return `@${target}: ${draft.message}${draft.summary ? `

${draft.summary}` : ""}`;
      }
      const result = typeof edit === "string"
        ? await runtime.compactApply!(this.roomId, edit, progress)
        : await runtime.compact!(this.roomId, progress);
      // finishCompactCommand's port signature widens `kind` to plain string for
      // callers outside this file; this file's own CommandReply keeps the exact
      // RoomEventKind literal the implementation actually returns below.
      return (await this.finishCompactCommand(target, result)) as CommandReply;
    } catch (error) {
      // /cancel aborted the pass on purpose: report that, not the raw harness
      // exit ("claude exited (signal SIGTERM)…" reads like a crash).
      if (this.compactCancels.has(target)) return `Compaction cancelled for @${target}.`;
      return `Compaction failed for @${target}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.compactCancels.delete(target);
      this.compactingAgents.delete(target);
      this.compactProgress.delete(target);
      await this.emitSnapshot();
    }
  }

  /** Shared post-eviction boundary, durable summary, and ctx-chip bookkeeping
   * for ordinary /compact and reviewed /compact --edit <text>. */
  async finishCompactCommand(target: string, { compacted, message, summary }: CompactResult): Promise<CommandReply> {
    const { nextCursor } = await this.room.eventsFrom(0);
    await this.setContextFloor(target, nextCursor);
    if (compacted && summary) await this.room.writeCompaction(target, nextCursor, summary);
    else if (compacted) await this.room.clearCompaction(target);
    const written = this.compactProgress.get(target)?.outputTokens;
    const maxTokens = this.contextUsage[target]?.maxTokens;
    const updated = written ? { usedTokens: written, ...(maxTokens ? { maxTokens } : {}) } : undefined;
    if (updated) this.contextUsage[target] = updated;
    else delete this.contextUsage[target];
    await this.room
      .updateState((current) => {
        if (updated) current.contextUsage = { ...(current.contextUsage ?? {}), [target]: updated };
        else if (current.contextUsage) delete current.contextUsage[target];
      })
      .catch(() => {});
    const text = `@${target}: ${message}`;
    return compacted ? { text, kind: "compact-complete" } : text;
  }

  /** /cancel: panic stop from any client — drops the durable queue and cancels
   * the running turn. Partial progress commits (WAL), so nothing is lost. */
  async runCancelCommand(): Promise<string> {
    const queued = this.queuedTasks.length;
    const cancelled = await this.cancelActiveTask();
    if (!cancelled && queued === 0) return "Nothing is running.";
    const parts: string[] = [];
    if (cancelled) parts.push("Cancelled the running turn (partial progress is kept)");
    if (queued > 0) parts.push(`${queued} queued message${queued === 1 ? "" : "s"} kept — running next`);
    return `${parts.join("; ")}.`;
  }

  /** /recall: user-facing search over the same index the recall tool and
   * auto-recall use — facts, episodes, and full room history. */
  async runRecallCommand(agent?: string, query?: string): Promise<string> {
    const trimmed = query?.trim();
    if (!trimmed) return "Usage: /recall [@agent] <query> — search memory and room history.";
    const target = agent ?? (await this.roomDefaultTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    if (!this.options.memory) return "Memory recall is not available in this workspace.";
    const context = await this.recallContext(target);
    const deep = this.options.memory.deepSearch?.bind(this.options.memory) ?? this.options.memory.search.bind(this.options.memory);
    const { hits, degraded } = await deep(target, trimmed, { limit: RECALL_COMMAND_LIMIT, context });
    const header = degraded.length ? `(recall degraded: ${degraded.join("; ")})\n` : "";
    if (!hits.length) return `${header}No matches for "${trimmed}" in @${target}'s memory or room history.`;
    return `Recall @${target} — "${trimmed}":\n${header}${formatMemoryHits(hits)}`;
  }

  /** /rewind: room-level checkpoint rollback. Truncates the transcript after
   * the n-th-last user message, resets every cursor and harness session, and
   * lets the next turn replay the kept transcript window — the one rewind
   * mechanism that works identically for every harness (sessions cannot be
   * rewound). */
  async runRewindCommand(countRaw?: string): Promise<string> {
    const count = countRaw ? Number.parseInt(countRaw, 10) : 1;
    if (!Number.isInteger(count) || count < 1) return "Usage: /rewind [n] — undo the last n user turns and their replies.";
    const dropped = await this.room.rewindTranscript(count);
    if (!dropped) return `Nothing to rewind: this room has fewer than ${count} user message${count === 1 ? "" : "s"}.`;
    // Forgetting the rewound exchanges is the point — sessions that saw them reset.
    await this.resetAfterTruncation("reset-sessions");
    return `Rewound ${count} user turn${count === 1 ? "" : "s"} (${dropped.length} event${dropped.length === 1 ? "" : "s"} removed). Agent sessions reset; the next turn replays the kept history.`;
  }

  /** /goal: pin an autonomous objective on this room. Shared daemon state +
   * the ordinary durable queue drive it — zero harness knowledge, so every
   * harness behaves identically (AGENTS.md RULE #0). */
  async runGoalCommand(command: Extract<SlashCommand, { type: "goal" }>): Promise<string> {
    if (command.sub === "set") {
      const objective = command.objective.trim();
      if (!objective) return "Usage: /goal [--tokens N] <objective> — pin an objective on this room.";
      const target = await this.roomDefaultTarget();
      if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
      const now = new Date().toISOString();
      const goal: RoomGoal = {
        objective,
        agentId: target,
        status: "active",
        ...(command.tokens ? { tokenBudget: command.tokens } : {}),
        tokensUsed: 0,
        iterations: 0,
        startedAt: now,
        updatedAt: now,
      };
      await this.updateGoal(() => goal);
      await this.enqueueGoalTurn(goal, false);
      const budget = goal.tokenBudget ? ` Budget: ${goal.tokenBudget.toLocaleString()} tokens.` : "";
      return `Goal pinned for @${target}: "${objective}".${budget} @${target} is starting now and keeps working until it writes ${GOAL_COMPLETE_SIGNAL} in a reply (no marker = not done). /goal pause to hold, /goal clear to drop.`;
    }
    const goal = (await this.room.state()).goal;
    if (command.sub === "status") {
      if (!goal) return "No goal pinned in this room. Set one with /goal <objective>.";
      const budget = goal.tokenBudget ? `${goal.tokensUsed.toLocaleString()}/${goal.tokenBudget.toLocaleString()} tokens` : `${goal.tokensUsed.toLocaleString()} tokens (no budget)`;
      const stopped = goal.stoppedReason ? `\nStopped: ${goal.stoppedReason}` : "";
      return `Goal (@${goal.agentId}, ${goal.status}): "${goal.objective}"\nIterations: ${goal.iterations} — ${budget}\nSince ${goal.startedAt}${stopped}`;
    }
    if (!goal) return "No goal pinned in this room. Set one with /goal <objective>.";
    if (command.sub === "clear") {
      await this.updateGoal(() => undefined);
      return `Goal cleared: "${goal.objective}".`;
    }
    if (command.sub === "pause") {
      if (goal.status === "paused") return "The goal is already paused.";
      await this.updateGoal((current) => ({ ...current, status: "paused", stoppedReason: "paused by a human" }));
      return `Goal paused: "${goal.objective}". /goal resume to continue.`;
    }
    // resume
    if (goal.status === "active") return "The goal is already active.";
    await this.updateGoal((current) => {
      const next: RoomGoal = { ...current, status: "active" };
      delete next.stoppedReason;
      return next;
    });
    const resumed = { ...goal, status: "active" as const };
    delete resumed.stoppedReason;
    await this.enqueueGoalTurn(resumed, true);
    const note = goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget ? " Note: the token budget is already spent — raise it with /goal --tokens N <objective>." : "";
    return `Goal resumed: "${goal.objective}".${note}`;
  }

  /** Single writer for the room goal: mutate-or-drop, then refresh clients. */
  async updateGoal(mutate: (current: RoomGoal) => RoomGoal | undefined): Promise<void> {
    await this.room.updateState((state) => {
      const next = state.goal ? mutate(state.goal) : mutate({} as RoomGoal);
      if (next?.objective) state.goal = next;
      else delete state.goal;
    });
    await this.emitSnapshot();
  }

  /** After a CLEAN goal turn: stop on the explicit completion signal or an
   * exhausted budget, otherwise enqueue the next continuation on the durable
   * queue (restart-safe). Strict by design — no signal means NOT done. */
  async maybeContinueGoal(author: string, reply: string, goalStartedAt: string): Promise<void> {
    const goal = (await this.room.state()).goal;
    if (!goal || goal.status !== "active" || goal.agentId !== author || goal.startedAt !== goalStartedAt) return;
    const spent = this.contextUsage[author]?.usedTokens ?? 0;
    const tokensUsed = goal.tokensUsed + spent;
    const iterations = goal.iterations + 1;
    const base: RoomGoal = { ...goal, tokensUsed, iterations, updatedAt: new Date().toISOString() };

    if (reply.includes(GOAL_COMPLETE_SIGNAL)) {
      await this.updateGoal(() => ({ ...base, status: "done", stoppedReason: `completed by @${author}` }));
      this.emitSystemNote(`Goal complete: "${goal.objective}" (${iterations} turn${iterations === 1 ? "" : "s"}).`);
      return;
    }
    if (base.tokenBudget && tokensUsed >= base.tokenBudget) {
      await this.updateGoal(() => ({ ...base, status: "paused", stoppedReason: `token budget exhausted (${tokensUsed}/${base.tokenBudget})` }));
      this.emitSystemNote(`Goal paused: token budget spent (${tokensUsed}/${base.tokenBudget}). /goal --tokens N <objective> to extend, /goal resume to continue.`);
      return;
    }
    await this.updateGoal(() => base);
    await this.enqueueGoalTurn(base, true);
  }

  // DogMode (/dog + its discipline verbs) is a bundled command-plugin now
  // (plugins/defaults/dog-mode.mjs) — no dedicated RoomService methods left;
  // dispatch runs through the generic command-plugin path in sendMessage()
  // plus the pluginRenderCap/pluginTurnStart/pluginPrompt hooks below.

  /** /thanks-dario: run a review now, or toggle auto-review on model fallback. */
  async runThanksDarioCommand(sub: "on" | "off" | "run"): Promise<string> {
    if (sub === "on" || sub === "off") {
      await this.room.updateState((state) => {
        if (sub === "on") state.thanksDario = true;
        else delete state.thanksDario;
      });
      await this.emitSnapshot();
      return sub === "on"
        ? "Thanks-Dario mode ON: when a provider-side safeguard reroutes this room's model, Dario reviews the transcript and proposes redactions — popup with a diff, nothing rewritten without your approval."
        : "Thanks-Dario mode OFF.";
    }
    const proposal = await this.sanitizePreview();
    const window = `${proposal.window} message${proposal.window === 1 ? "" : "s"}`;
    if (proposal.parseError) {
      return `Dario reviewed ${window} but his reply did not parse as suggestions (${proposal.parseError}). His raw notes are in the review popup.`;
    }
    if (proposal.suggestions.length === 0) {
      return `Dario reviewed ${window} and found nothing that should trip a classifier. ${proposal.summary}`.trim();
    }
    return `Dario reviewed ${window}: ${proposal.suggestions.length} suggested edit${proposal.suggestions.length === 1 ? "" : "s"} ready in the review popup. Nothing is rewritten until you approve.`;
  }

  /** Run the reviewer persona over the events a fresh session would replay
   * and persist his proposal. Read-only — apply is a separate, human-approved
   * step. The reviewer runs through the ordinary summon path (sandboxed child
   * room, any harness/provider), so there is nothing harness-specific here. */
}
export interface RoomCommandsMixin extends RoomCommandsFacadePort {}

export function installRoomCommands(target: object): void { for (const name of Object.getOwnPropertyNames(RoomCommandsMixin.prototype)) if (name !== "constructor") Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomCommandsMixin.prototype, name)!); }
