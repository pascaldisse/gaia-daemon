// Summons: an agent running in a child room, Claude-Code-subagent style. The
// coordinator owns only the cross-room piece (creating + linking child rooms,
// the per-room cap, result delivery); the turn itself runs through the child
// room's own service — streaming, persistence, steering and recursion all come
// from the room machinery.
//
// The contract (uniform for every harness, RULE #0):
//   - launch NEVER blocks the caller's turn — it returns the child room id
//     immediately and the worker runs in the background;
//   - the worker is watchable live in its sub-room (parentRoomId → sidebar);
//   - when the worker finishes, its result is DELIVERED back into the parent
//     room — as a COLLAPSED note authored by the worker, plus (deliver: "turn")
//     a nudge that re-invokes the calling agent (steer its running turn, else a
//     fresh turn) so it continues — Claude-Code subagent style, never a queued
//     "user →" bubble;
//   - delivery is durable: the pending delivery is stamped on the child room's
//     state at launch, and a daemon restart re-arms it (recoverUndelivered) —
//     a summon result is NEVER silently lost;
//   - failures are delivered too, loudly — never swallowed.
//
// Trust policy lives here as well: one bit (`trust: false`) forces the sandbox
// and bars summoning; nested summons are default-deny.

import { readdir } from "node:fs/promises";
import type { AgentDef, SummonDelivery, Workspace } from "../core/types.js";

/** How a finished worker's result lands in the parent room (see
 * SummonRoomAccess.deliverAgentResult). */
export interface SummonResultDelivery {
  /** The worker's child room — provenance for the collapsed result header. */
  childRoomId: string;
  /** The worker turn errored rather than finishing cleanly. */
  failed: boolean;
  /** deliver:"turn" — the caller agent to re-invoke with the result. Unset for
   * deliver:"note" (a human reads the result; no agent is nudged). */
  triggerTarget?: string;
}

import { normalizeRoomState } from "../domain/rooms.js";
import { workspacePaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { ensureWorkspaceRoom } from "../domain/workspace.js";

export function isTrusted(agent: AgentDef): boolean {
  return agent.trust !== false;
}

/** May `agent` create summons while running AS a summon? Default-deny; opt in
 * with allowNestedSummon — refused regardless for untrusted agents. */
export function mayNestSummon(agent: AgentDef): boolean {
  if (!isTrusted(agent)) return false;
  return agent.allowNestedSummon === true;
}

/** Whether this turn's bridge token may create summons. */
export function allowSummonForTurn(agent: AgentDef, isSummon: boolean): boolean {
  return isSummon ? mayNestSummon(agent) : true;
}

export interface SummonChild {
  roomId: string;
  parentRoomId: string;
  agentId: string;
  prompt: string;
}

/** A task chip as the coordinator sees it (RoomService.Task, structurally). */
export interface SummonTask {
  id: string;
  status: string;
  error?: string;
}

export interface SummonTaskEvent {
  type: string;
  task?: { id: string };
}

/** What the coordinator needs from a room service (narrow, injectable). */
export interface SummonRoomAccess {
  sendMessage(text: string, options: { targets: string[]; bypassContextGate?: boolean }): Promise<SummonTask>;
  subscribe(listener: (event: SummonTaskEvent) => void): () => void;
  latestReplyFrom(agentId: string): Promise<string>;
  /** Fully settled: no running task, no durable pending turn, empty queue
   * (covers turns that init() resumes asynchronously after a restart). */
  waitForSettled(): Promise<void>;
  /** Land a worker's result in a PARENT room: a COLLAPSED, summon-labeled note
   * authored by the worker, then — when `triggerTarget` is set (deliver:"turn")
   * — nudge that caller agent to react (steer its running turn, else a fresh
   * turn). Never a queued "user →" bubble. */
  deliverAgentResult(fromAgentId: string, reply: string, delivery: SummonResultDelivery): Promise<void>;
  /** Stamp this CHILD room's summon record delivered (idempotent). */
  markSummonDelivered(): Promise<void>;
}

/** Resolve when `task` settles (its object is live-mutated by the service), or
 * after timeoutMs when given — a run past the cap keeps going in its room. */
export function awaitTask(room: { subscribe(listener: (event: SummonTaskEvent) => void): () => void }, task: SummonTask, timeoutMs?: number): Promise<void> {
  const settled = (): boolean => task.status !== "running" && task.status !== "queued";
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(finish, timeoutMs);
    timer?.unref?.();
    const unsubscribe = room.subscribe((event) => {
      if ((event.type === "task-end" || event.type === "task-error") && event.task?.id === task.id) finish();
    });
    // Settled in the window before subscribing? The live object tells us.
    if (settled()) finish();
  });
}

export interface SummonOptions {
  /** Deliver the worker's result back into the parent room when it settles:
   *  "note" — appended as a message from the worker (human-visible, no turn);
   *  "turn" — the note PLUS a queued turn for callerAgentId (the subagent
   *  callback: the calling agent is re-invoked with the result).
   *  Omitted → no delivery; the caller consumes the settled promise itself
   *  (summonAndWait: monad steps, the sanitize reviewer, scheduled runs). */
  deliver?: "note" | "turn";
  /** The parent-room agent whose turn a "turn" delivery triggers. */
  callerAgentId?: string;
}

export interface SummonHost {
  /** Kick off a background summon and return its child room id immediately. */
  summon(parentRoomId: string, agentId: string, task: string, options?: SummonOptions): Promise<string>;
  /** Kick off and await the worker's final reply (internal orchestration —
   * monad/sanitize/scheduler — never a live agent turn, which must not block). */
  summonAndWait(parentRoomId: string, agentId: string, task: string): Promise<string>;
  /** Running summons; a parent room's direct children, or all when omitted. */
  runningChildren(parentRoomId?: string): SummonChild[];
}

/** summonAndWait callers stop waiting after this long; the worker's turn keeps
 * going in its room and the result is read from the transcript later.
 * Background (delivered) summons have NO deadline — they call back whenever
 * they finish, and a restart re-arms them. */
export const SUMMON_TIMEOUT_MS = 300_000;

/** The tool-facing acknowledgment for a background summon — the ONE place this
 * contract is worded, shared by the HTTP endpoint and the in-process tool. */
export function summonAck(agentId: string, childRoomId: string): string {
  return (
    `Summoned @${agentId} — running in the background in sub-room '${childRoomId}' ` +
    `(nested under this room in the sidebar; open it to watch live). ` +
    `Do NOT wait or poll: when the worker finishes, its result is posted back to this room and you will be invoked to continue.`
  );
}

export class SummonCoordinator implements SummonHost {
  /** childRoomId -> info, for summons whose first turn is still running (the
   * cap + live snapshot). Completed summons live on as child rooms on disk. */
  private readonly running = new Map<string, SummonChild>();

  constructor(
    private readonly workspace: Workspace,
    private readonly workspacePath: string,
    private readonly serviceForRoom: (roomId: string) => Promise<SummonRoomAccess>,
    private readonly maxPerRoom: number,
    private readonly log: (message: string) => void = (message) => console.warn(`[gaia] ${message}`),
  ) {}

  runningChildren(parentRoomId?: string): SummonChild[] {
    const all = [...this.running.values()];
    return parentRoomId === undefined ? all : all.filter((child) => child.parentRoomId === parentRoomId);
  }

  async summon(parentRoomId: string, agentId: string, task: string, options: SummonOptions = {}): Promise<string> {
    const { roomId } = await this.launch(parentRoomId, agentId, task, options);
    return roomId;
  }

  async summonAndWait(parentRoomId: string, agentId: string, task: string): Promise<string> {
    const { done } = await this.launch(parentRoomId, agentId, task);
    return done;
  }

  /** Kick off a summon exposing BOTH the child room id and the settled-result
   * promise — callers that must persist the room id before awaiting (the
   * scheduler's crash-recovery mark) use this. */
  async launch(parentRoomId: string, agentId: string, task: string, options: SummonOptions = {}): Promise<{ roomId: string; done: Promise<string> }> {
    if (!this.workspace.agents[agentId]) throw new Error(`Unknown agent: @${agentId}`);
    if (this.runningChildren(parentRoomId).length >= this.maxPerRoom) {
      throw new Error(`Too many running summons in room ${parentRoomId}; wait for one to finish or cancel it first.`);
    }

    const childRoomId = `${agentId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
    await ensureWorkspaceRoom(this.workspacePath, childRoomId);

    // Stamp the parent link — and the pending delivery — BEFORE the child
    // service reads state at init, so both survive the service's own state
    // writes. The delivery record is what makes the callback durable: a
    // restart finds it and re-arms (recoverUndelivered).
    const statePath = workspacePaths.roomState(this.workspace.rootDir, childRoomId);
    const state = normalizeRoomState(await readJson(statePath));
    state.parentRoomId = parentRoomId;
    if (options.deliver) {
      state.summon = {
        agentId,
        deliver: options.deliver,
        ...(options.callerAgentId ? { callerAgentId: options.callerAgentId } : {}),
        status: "running",
        launchedAt: new Date().toISOString(),
      };
    }
    await writeJsonAtomic(statePath, state);

    const child = await this.serviceForRoom(childRoomId);
    const info: SummonChild = { roomId: childRoomId, parentRoomId, agentId, prompt: task };
    this.running.set(childRoomId, info);

    const done = this.runChild(child, info, task, options).finally(() => this.running.delete(childRoomId));
    // Don't crash on background summons whose result no one awaits.
    done.catch(() => {});
    return { roomId: childRoomId, done };
  }

  /** Run the worker's first turn; with a delivery mode, land the result (or the
   * failure, loudly) in the parent room afterwards. */
  private async runChild(child: SummonRoomAccess, info: SummonChild, task: string, options: SummonOptions): Promise<string> {
    if (!options.deliver) return this.runFirstTurn(child, info.agentId, task, SUMMON_TIMEOUT_MS);

    let reply: string;
    let failed = false;
    try {
      // No deadline: a background worker calls back whenever it finishes.
      reply = await this.runFirstTurn(child, info.agentId, task);
    } catch (error) {
      failed = true;
      reply = error instanceof Error ? error.message : String(error);
    }
    try {
      await this.deliver(child, info, options, reply, failed);
    } catch (error) {
      // Leave the child's summon record "running": the boot sweep retries the
      // delivery on the next daemon start instead of losing the result.
      this.log(`summon '${info.roomId}' finished but delivering its result to '${info.parentRoomId}' failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failed) throw new Error(reply);
    return reply;
  }

  /** Summons run autonomously: the context gate (a human decision modal) must
   * never hold a worker's first turn. */
  private async runFirstTurn(child: SummonRoomAccess, agentId: string, task: string, timeoutMs?: number): Promise<string> {
    const turn = await child.sendMessage(task, { targets: [agentId], bypassContextGate: true });
    await awaitTask(child, turn, timeoutMs);
    if (turn.status === "running" || turn.status === "queued") {
      return `summon timed out after ${Math.round((timeoutMs ?? SUMMON_TIMEOUT_MS) / 60_000)} minutes`;
    }
    if (turn.status === "error") throw new Error(turn.error || "summon turn failed");
    const reply = (await child.latestReplyFrom(agentId)).trim();
    return reply || "(no output)";
  }

  /** Land a worker's result in the parent room: a COLLAPSED note authored by
   * the worker (the "↩︎ summon finished / ⚠️ FAILED" header is rendered from
   * SummonResultMeta, not baked into the text), then — deliver:"turn" — nudge
   * the caller agent to continue. Marks the child's durable record delivered
   * ONLY after the parent write committed — a crash in between re-delivers
   * rather than losing it. */
  private async deliver(child: SummonRoomAccess, info: SummonChild, options: Pick<SummonOptions, "deliver" | "callerAgentId">, reply: string, failed: boolean): Promise<void> {
    const parent = await this.serviceForRoom(info.parentRoomId);
    await parent.deliverAgentResult(info.agentId, reply, {
      childRoomId: info.roomId,
      failed,
      ...(options.deliver === "turn" && options.callerAgentId ? { triggerTarget: options.callerAgentId } : {}),
    });
    await child.markSummonDelivered();
  }

  /** Boot sweep: find child rooms whose delivery record is still "running" —
   * a prior process launched them and died (mid-turn or between finishing and
   * delivering) — reopen each (init resumes its turn from the WAL), wait for
   * it to settle, and deliver. NO PROGRESS EVER LOST. */
  async recoverUndelivered(): Promise<void> {
    let roomIds: string[];
    try {
      roomIds = await readdir(this.workspace.roomsDir);
    } catch {
      return;
    }
    for (const roomId of roomIds) {
      if (this.running.has(roomId)) continue;
      let record: SummonDelivery | undefined;
      let parentRoomId: string | undefined;
      try {
        const state = normalizeRoomState(await readJson(workspacePaths.roomState(this.workspace.rootDir, roomId)));
        record = state.summon;
        parentRoomId = state.parentRoomId;
      } catch {
        continue;
      }
      if (!record || record.status !== "running" || !parentRoomId) continue;
      const info: SummonChild = { roomId, parentRoomId, agentId: record.agentId, prompt: "" };
      this.running.set(roomId, info);
      this.log(`summon recovery: re-arming '${roomId}' (@${record.agentId} → '${parentRoomId}')`);
      void this.recoverOne(info, record)
        .catch((error) => this.log(`summon recovery for '${roomId}' failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.running.delete(roomId));
    }
  }

  private async recoverOne(info: SummonChild, record: SummonDelivery): Promise<void> {
    const child = await this.serviceForRoom(info.roomId); // init() resumes the WAL turn / queue
    await child.waitForSettled();
    const reply = (await child.latestReplyFrom(info.agentId)).trim();
    await this.deliver(
      child,
      info,
      record,
      reply || "the worker produced no output before the daemon restarted — open the sub-room and re-summon if needed",
      !reply,
    );
  }
}
