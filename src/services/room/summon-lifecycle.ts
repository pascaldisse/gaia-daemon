// Summon lifecycle + agent-dialogue delivery cohort: active-agent tracking,
// agent@agent hand-off dispatch/queueing, goal-turn kickoff, summon-result
// delivery back into the caller's room (steer-or-fresh-turn), and the
// coordinator-facing settle/delivered-marker surface. Split from
// room-service.ts (Pascal 2026-09-03 A6d).

import { GOAL_COMPLETE_SIGNAL } from "../../core/types.js";
import type { RoomGoal } from "../../core/types.js";
import { sleep } from "../../core/retry.js";
import { mentionedAgents } from "../commands.js";
import type { ResumeEpoch } from "../resume-epoch.js";
import type { SummonResultDelivery } from "../summons.js";
import type { RoomSummonLifecyclePort } from "./ports.js";

/** Max consecutive agent→agent hand-offs before room agent-dialogue pauses and
 * waits for a human. The toggle is the on/off; this is the runaway backstop. */
export const AGENT_DIALOGUE_MAX_HOPS = 8;

export class RoomSummonLifecycleMixin {
  /** Remember the agent a turn addressed as this room's active agent (persisted,
   * best-effort). The last target of a broadcast wins — that's who a bare next
   * message goes to. Skips unknown ids so a stale write can't wedge routing. */
  async rememberActiveAgent(targets: string[]): Promise<void> {
    const next = [...targets].reverse().find((id) => this.workspace.agents[id]);
    if (!next) return;
    if ((await this.room.state()).activeAgent === next) return;
    await this.room.updateState((state) => {
      state.activeAgent = next;
    });
  }

  /** Room agent-dialogue: after @author's reply commits, if the room toggle is
   * on, let any OTHER known agent it @mentioned (anywhere in the reply) respond
   * in this room. Bounded by AGENT_DIALOGUE_MAX_HOPS consecutive hand-offs since
   * the last human message so a mutual @mention can't loop forever. */
  async maybeDispatchAgentDialogue(author: string, reply: string): Promise<void> {
    if (!(await this.room.state()).agentDialogue) return;
    const targets = mentionedAgents(reply, new Set(Object.keys(this.workspace.agents))).filter((id) => id !== author);
    if (targets.length === 0) return;
    if (this.agentDialogueHops >= AGENT_DIALOGUE_MAX_HOPS) {
      this.emitSystemNote(`Agent dialogue paused after ${AGENT_DIALOGUE_MAX_HOPS} hops (loop guard) — send a message to continue.`);
      return;
    }
    this.agentDialogueHops += 1;
    await this.enqueueAgentDialogue(targets, reply);
  }

  /** Queue an agent-authored turn durably. The addressing text is already in
   * the transcript, so the turn replays it as the "newest message" WITHOUT
   * re-recording (recordUserMessage:false, set by drain from the
   * fromAgentDialogue flag). Never command-parsed. Backs both agent-dialogue
   * hand-offs (queued mid-turn; settle drains) and summon callbacks (queued
   * from outside; kick drain when idle). Marked `callback` so the client
   * renders no "user →" ghost — the driving text is an agent message/pointer,
   * not something a person typed. */
  private async enqueueAgentDialogue(
    targets: string[],
    text: string,
    options: { goalStartedAt?: string; kick?: boolean } = {},
  ): Promise<void> {
    const task = this.createTask(text, targets);
    task.status = "queued";
    task.callback = true;
    await this.room.enqueue({
      taskId: task.id,
      text,
      targets,
      fromAgentDialogue: true,
      ...(options.goalStartedAt ? { goalStartedAt: options.goalStartedAt } : {}),
      queuedAt: task.startedAt,
    });
    this.queuedTasks.push(task);
    this.emit({ type: "task-start", workspaceId: this.workspaceId, roomId: this.roomId, task });
    void this.emitSnapshot();
    if (options.kick !== false && !this.activeTask) void this.drain();
  }

  /** Queue one synthetic goal turn through the ordinary durable agent path. */
  async enqueueGoalTurn(goal: RoomGoal, continuing: boolean, kick = true): Promise<void> {
    const verb = continuing ? "Continue" : "Begin";
    await this.enqueueAgentDialogue(
      [goal.agentId],
      `${verb} the pinned room goal: "${goal.objective}". Work autonomously from the room context. When — and only when — the goal is fully achieved, write ${GOAL_COMPLETE_SIGNAL} on its own line; otherwise keep working.`,
      { goalStartedAt: goal.startedAt, kick },
    );
  }

  /** Deliver a background worker's result into this room (the summon callback):
   * append it as a COLLAPSED, summon-labeled note authored by the worker, then
   * — deliver:"turn" — nudge the caller agent to continue (Claude-Code subagent
   * style). The nudge STEERS the caller's running turn if it has one, else it
   * runs a fresh turn; either way the caller reads the full result from the note
   * (loaded as context past its cursor) and no misleading "user →" bubble is
   * created. Durable: the note is on disk before we nudge, and the nudge itself
   * rides the durable queue when it can't run now. */
  async deliverAgentResult(fromAgentId: string, reply: string, delivery: SummonResultDelivery): Promise<void> {
    await this.init();
    await this.postAgentNote(fromAgentId, reply, {
      summonResult: { childRoomId: delivery.childRoomId, failed: delivery.failed },
    });
    const target = delivery.triggerTarget;
    if (target && this.workspace.agents[target]) await this.triggerSummonCallback(target, reply, delivery);
  }

  /** Public rooms rebroadcast for the summon coordinator: a summon child
   * leaving the coordinator's running set changes the PARENT room's
   * banner/sidebar truth, but the child's own task-end broadcast raced
   * ahead of that cleanup — the coordinator calls this after dropping the
   * child so clients stop counting a dead summon. */
  async broadcastRoomsChanged(): Promise<void> {
    await this.emitRoomsChanged();
  }

  /** Re-invoke a caller agent after its summon returned — steer its live turn if
   * it has one (the harness picks up the nudge at the next tool boundary), else
   * a fresh turn. Never records a "user →" bubble. Two paths, two shapes:
   * - STEER: the running turn began before the result note existed and can't
   *   re-read the transcript, so the steer carries the FULL result inline.
   * - FRESH TURN: the note is already on disk and loads as context (past the
   *   caller's cursor), so the prompt is a short pointer, not a re-paste
   *   (recordUserMessage:false / callback:true → no user ghost). */
  private async triggerSummonCallback(target: string, reply: string, delivery: SummonResultDelivery): Promise<void> {
    const runtime = this.runtimes[target];
    if (this.activeAgentTurn?.targets.includes(target) && runtime?.capabilities.supportsSteer) {
      const header = delivery.failed
        ? `Your summon '${delivery.childRoomId}' FAILED (decide how to proceed):`
        : `Your summon '${delivery.childRoomId}' returned:`;
      const ok = (await runtime.steer?.(this.roomId, `${header}\n\n${reply}`)) ?? false;
      if (ok) return; // else the turn just ended — fall through to a fresh turn
    }
    const pointer = delivery.failed
      ? `Your summon '${delivery.childRoomId}' FAILED — its error is in the message just above. Decide how to proceed (retry, work around, or report it).`
      : `Your summon '${delivery.childRoomId}' finished — its result is in the message just above. Continue from it.`;
    await this.enqueueAgentDialogue([target], pointer);
  }

  /** True while a queued message or durable pending-turn marker still exists — i.e. the room
   * will run again without outside input (auth-retry requeue etc.). */
  async hasPendingWork(): Promise<boolean> {
    await this.init();
    return Boolean(this.activeTask || this.queuedTasks.length > 0 || (await this.room.state()).pendingTurn != null);
  }

  /** Resolves when the room has FULLY settled: no running task, no durable
   * pending turn, an empty queue — stable across two consecutive checks
   * (init() resumes a prior process's turn asynchronously, so a single
   * idle observation right after open can be a lie). Unlike waitForIdle
   * (one task), this covers everything the room is still going to run —
   * the summon-recovery wait. */
  async waitForSettled(): Promise<void> {
    await this.init();
    let stable = 0;
    for (;;) {
      if (this.activeTask) {
        stable = 0;
        await this.waitForIdle();
      }
      const state = await this.room.state();
      const settled = !this.activeTask && !state.pendingTurn && (state.queue?.length ?? 0) === 0;
      stable = settled ? stable + 1 : 0;
      if (stable >= 2) return;
      await sleep(250);
    }
  }

  /** Mark this (summon child) room's durable delivery record as delivered —
   * called by the coordinator AFTER the result landed in the parent room, so
   * a crash in between re-delivers instead of losing the result. */
  async markSummonDelivered(): Promise<void> {
    await this.init();
    await this.room.updateState((state) => {
      if (state.summon) state.summon.status = "delivered";
    });
  }

  /** Fix #1 (resume-completion tracking): mark THIS room's most recent
   * `gaia resume` durable record delivered — called by the coordinator AFTER
   * the resumed turn's result landed in the parent room. Independent of
   * `status` above (stays "delivered" from the original first-turn summon);
   * see SummonDelivery.resumeStatus. */
  async markSummonResumeDelivered(token: ResumeEpoch): Promise<void> {
    await this.init();
    await this.room.updateState((state) => {
      if (!state.summon) return;
      // Epoch-keyed and MANDATORY (RC6): a close names the exact resume it
      // finished. A later resume already overwrote resumeStartedAt — a stale
      // watcher must not clear that newer, still-running epoch. There is no
      // token-less close: an unguarded one would clear whatever is live.
      if (state.summon.resumeStartedAt !== token) return;
      state.summon.resumeStatus = "delivered";
    });
  }
}

export interface RoomSummonLifecycleMixin extends RoomSummonLifecyclePort {}

export function installRoomSummonLifecycle(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomSummonLifecycleMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomSummonLifecycleMixin.prototype, name)!);
  }
}
