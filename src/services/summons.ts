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
// Trust policy lives here as well: one bit (`trust: false`) forces the sandbox.
// A TRUSTED agent's summon runs unsandboxed, exactly like its top-level turns —
// being a summon is not itself a reason to confine. The boundary is the TRUST
// tier, and it FOLLOWS delegation as data: a summon launched by an untrusted
// caller (or from a room already running under the untrusted tier) runs under
// the untrusted tier itself — forced real sandbox regardless of the worker
// agent's own trust bit, so an untrusted agent can never escape its sandbox by
// summoning. Nested summons are default-deny. No approval gates anywhere —
// summons run autonomously; the trust tier IS the boundary.

import { readdir, readFile } from "node:fs/promises";
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
import { ensureRoomWorktree, resolveRoomWorkDir } from "../domain/worktree.js";
import { workspacePaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { ensureWorkspaceRoom } from "../domain/workspace.js";

export function isTrusted(agent: AgentDef): boolean {
  return agent.trust !== false;
}

/** Effective trust of a turn: the agent's own bit AND the untrusted tier its
 * room inherited from the summon chain (summonUntrustedTier). This is the
 * `trusted` input for sandbox resolution — an untrusted caller's summons run
 * forced-sandbox regardless of the worker's own trust bit, and no agent or
 * workspace config can weaken that: the tier is derived data, never config. */
export function effectiveTrust(agent: AgentDef, untrustedTier: boolean): boolean {
  return isTrusted(agent) && !untrustedTier;
}

/** The tier a summon CHILD room runs under: untrusted when the launching
 * caller agent is untrusted OR the parent room itself already runs under the
 * untrusted tier — the tier is transitive down the delegation chain, so an
 * untrusted agent can never launder work back to the trusted tier through an
 * intermediary. Launches without a caller agent (a human's /summon, daemon
 * orchestration like monad/sanitize/scheduler) start from the trusted root. */
export function summonUntrustedTier(caller: AgentDef | undefined, parentUntrustedTier: boolean): boolean {
  return parentUntrustedTier || (caller !== undefined && !isTrusted(caller));
}

/** May `agent` create summons while running AS a summon? Default-deny; opt in
 * with allowNestedSummon — refused regardless for untrusted agents. */
export function mayNestSummon(agent: AgentDef): boolean {
  if (!isTrusted(agent)) return false;
  return agent.allowNestedSummon === true;
}

/** Whether this turn's bridge token may create summons. Top-level turns always
 * may — an untrusted agent is NOT gated out of summoning; its summons simply
 * inherit its tier (summonUntrustedTier) and run forced-sandbox. Nested turns
 * follow mayNestSummon, judged on EFFECTIVE trust: a turn under an inherited
 * untrusted tier nests exactly like an untrusted agent's turn — never. */
export function allowSummonForTurn(agent: AgentDef, isSummon: boolean, untrustedTier = false): boolean {
  if (!isSummon) return true;
  return effectiveTrust(agent, untrustedTier) && mayNestSummon(agent);
}

export interface SummonChild {
  roomId: string;
  parentRoomId: string;
  agentId: string;
  prompt: string;
  /** This child runs under the untrusted tier (its caller agent was untrusted,
   * or it was launched from an untrusted-tier room): its turns must resolve
   * their sandbox with effectiveTrust(agent, true) — forced real backend
   * regardless of the worker's own trust bit — and any summon it launches
   * inherits the tier. */
  untrusted: boolean;
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
  /** Recent + in-flight/queued tasks for this room, most-recent last. Summon
   * recovery reads the last entry's status/error to tell an errored or
   * cancelled resumed turn apart from a plain empty reply — no other channel
   * carries that distinction after a daemon restart. */
  getSnapshot(): Promise<{ tasks: SummonTask[] }>;
  /** Land a worker's result in a PARENT room: a COLLAPSED, summon-labeled note
   * authored by the worker, then — when `triggerTarget` is set (deliver:"turn")
   * — nudge that caller agent to react (steer its running turn, else a fresh
   * turn). Never a queued "user →" bubble. */
  deliverAgentResult(fromAgentId: string, reply: string, delivery: SummonResultDelivery): Promise<void>;
  /** Stamp this CHILD room's summon record delivered (idempotent). */
  markSummonDelivered(): Promise<void>;
  /** Panic-stop this room's active turn — the EXACT plumbing the /cancel
   * slash command uses (cancelActiveTask under the hood): aborts the runner,
   * lets the partial commit (NO PROGRESS EVER LOST), settles the task
   * "cancelled". The summon timeout's cancel path reuses this rather than
   * inventing a second one. */
  runCancelCommand(): Promise<string>;
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

/** Best-effort read of what a worker actually did, extracted mechanically
 * from the child transcript. Model-free on purpose — the last-resort path
 * must never be able to fail. Feeds three things: the progress-digest tail
 * appended to every non-clean outcome (`digest`, unchanged shape from the
 * original progressDigest); whether the worker did ANYTHING at all — text or
 * a tool call — which is the failure bar for a turn that completed with an
 * empty final reply (`active`: false means it never got going); and the
 * harness's own last words, passed through verbatim, preferred as a failure
 * headline over the generic fallback when the worker said something before
 * going quiet (`lastText`). Also surfaces the last recorded system
 * turn-failure line (failure) so a summon failure message can always show
 * the real error even when the worker itself wrote nothing. */
async function inspectWorker(rootDir: string, roomId: string, agentId: string): Promise<{ digest: string; active: boolean; lastText: string; failure: string }> {
  let raw: string;
  try {
    raw = await readFile(workspacePaths.transcript(rootDir, roomId), "utf8");
  } catch {
    return { digest: "", active: false, lastText: "", failure: "" };
  }
  let firstTs = "";
  let lastTs = "";
  const texts: string[] = [];
  let active = false;
  let failure = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: { author?: unknown; text?: unknown; timestamp?: unknown; details?: { tools?: unknown[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.author === "system" && typeof event.text === "string" && event.text.startsWith("⚠ turn failed")) {
      failure = event.text;
      continue;
    }
    if (event.author !== agentId) continue;
    if (Array.isArray(event.details?.tools) && event.details.tools.length > 0) active = true;
    if (typeof event.text !== "string" || event.text.length === 0) continue;
    active = true;
    if (!firstTs) firstTs = typeof event.timestamp === "string" ? event.timestamp : "";
    if (typeof event.timestamp === "string") lastTs = event.timestamp;
    texts.push(event.text);
  }
  const digest =
    texts.length === 0
      ? "the worker produced no output before it stopped."
      : `progress until then (${texts.length} update(s), ${firstTs} → ${lastTs}):\n\n${texts
          .slice(-3)
          .map((text) => (text.length > 600 ? `${text.slice(0, 600)}…` : text))
          .join("\n---\n")}`.slice(0, 2400);
  return { digest, active, lastText: texts.at(-1) ?? "", failure };
}

export interface SummonOptions {
  /** Deliver the worker's result back into the parent room when it settles:
   *  "note" — appended as a message from the worker (human-visible, no turn);
   *  "turn" — the note PLUS a queued turn for callerAgentId (the subagent
   *  callback: the calling agent is re-invoked with the result).
   *  Omitted → no delivery; the caller consumes the settled promise itself
   *  (summonAndWait: monad steps, the sanitize reviewer, scheduled runs). */
  deliver?: "note" | "turn";
  /** The parent-room agent on whose behalf this summon runs. Two uses, both
   * uniform across harnesses: a "turn" delivery triggers this agent's turn
   * with the result, and the child inherits this agent's trust tier — the
   * coordinator looks the agent up itself (summonUntrustedTier), so an
   * untrusted caller cannot claim trust for its workers. */
  callerAgentId?: string;
  /** Opt-in checkout isolation for this child: when true under worktree
   * isolation, the child owns its own worktree instead of inheriting the
   * parent room's checkout. */
  ownWorktree?: boolean;
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

/** Hard cap on a worker's FIRST turn (runFirstTurn) — covers a harness that
 * hangs, loops, or silently runs out of usage without ever erroring. Applies
 * uniformly to every summon path: awaited (summonAndWait) and background
 * (deliver: "note"/"turn") alike — a background summon is exactly the one
 * nobody is watching, so it must not be allowed to hang unnoticed forever.
 * Past this, the turn is force-cancelled (the room's own /cancel plumbing —
 * see SummonRoomAccess.runCancelCommand) and the summon fails loudly instead
 * of leaving an orphaned turn running. */
export const SUMMON_TIMEOUT_MS = 30 * 60_000; // 30 minutes

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
    private readonly maxPerRoom: () => Promise<number>,
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
    const cap = await this.maxPerRoom();
    if (this.runningChildren(parentRoomId).length >= cap) {
      throw new Error(`Too many running summons in room ${parentRoomId}; wait for one to finish or cancel it first.`);
    }

    // The child's trust tier, derived HERE — the one choke point every summon
    // creation passes through — from data the coordinator owns (the caller's
    // AgentDef from the workspace, the parent's own tier), never from a
    // caller-supplied flag. An untrusted caller's worker runs untrusted, full
    // stop; the summon itself is never denied for it (data flow, not gating).
    const caller = options.callerAgentId ? this.workspace.agents[options.callerAgentId] : undefined;
    const untrusted = summonUntrustedTier(caller, this.running.get(parentRoomId)?.untrusted === true);

    const childRoomId = `${agentId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
    await ensureWorkspaceRoom(this.workspacePath, childRoomId);

    // Stamp the parent link — and the pending delivery — BEFORE the child
    // service reads state at init, so both survive the service's own state
    // writes. The delivery record is what makes the callback durable: a
    // restart finds it and re-arms (recoverUndelivered).
    const statePath = workspacePaths.roomState(this.workspace.rootDir, childRoomId);
    const state = normalizeRoomState(await readJson(statePath));
    state.parentRoomId = parentRoomId;
    // The tier rides the room's durable state (like incognito: stamped once at
    // creation, immutable) so a daemon restart resumes the child's turn under
    // the SAME forced sandbox instead of quietly promoting it to trusted.
    if (untrusted) state.summonUntrusted = true;
    // Worktree isolation (collab.isolation "worktree"): summons inherit the
    // parent room's checkout by default. ownWorktree is an explicit opt-in for
    // a child-owned checkout; if that cannot be created, degrade to the normal
    // inherited resolution.
    let workDir: string | undefined;
    if (options.ownWorktree && this.workspace.config.collab?.isolation === "worktree") {
      workDir = ensureRoomWorktree(this.workspace.rootDir, childRoomId, this.workspace.config.collab.branchPrefix);
    }
    workDir ??= await resolveRoomWorkDir(this.workspace.rootDir, this.workspace.config.collab, state, childRoomId);
    if (workDir) state.workDir = workDir;
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
    const info: SummonChild = { roomId: childRoomId, parentRoomId, agentId, prompt: task, untrusted };
    this.running.set(childRoomId, info);

    const done = this.runChild(child, info, task, options).finally(() => this.running.delete(childRoomId));
    // Don't crash on background summons whose result no one awaits.
    done.catch(() => {});
    return { roomId: childRoomId, done };
  }

  /** Run the worker's first turn; with a delivery mode, land the result (or the
   * failure, loudly) in the parent room afterwards. */
  private async runChild(child: SummonRoomAccess, info: SummonChild, task: string, options: SummonOptions): Promise<string> {
    if (!options.deliver) return this.runFirstTurn(child, info.agentId, task, info.roomId);

    let reply: string;
    let failed = false;
    try {
      reply = await this.runFirstTurn(child, info.agentId, task, info.roomId);
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
  private async runFirstTurn(child: SummonRoomAccess, agentId: string, task: string, roomId: string): Promise<string> {
    const turn = await child.sendMessage(task, { targets: [agentId], bypassContextGate: true });
    await awaitTask(child, turn, SUMMON_TIMEOUT_MS);
    if (turn.status === "running" || turn.status === "queued") {
      // Hard cap hit: the worker hung, is looping, or ran out of usage
      // without the harness ever erroring out. Force it to stop via the SAME
      // plumbing /cancel uses (no second cancel path) — its partial progress
      // still commits (NO PROGRESS EVER LOST) — then fail loudly instead of
      // leaving an orphaned turn running unwatched forever.
      await child.runCancelCommand();
      const { digest } = await inspectWorker(this.workspace.rootDir, roomId, agentId);
      throw new Error(["summon timed out after 30 minutes", digest].filter(Boolean).join("\n\n"));
    }
    const worker = await inspectWorker(this.workspace.rootDir, roomId, agentId);
    if (turn.status === "error") throw new Error([turn.error || worker.failure || "summon turn failed", worker.digest].filter(Boolean).join("\n\n"));
    if (turn.status === "cancelled") throw new Error(["cancelled before completion", worker.digest].filter(Boolean).join("\n\n"));
    const reply = (await child.latestReplyFrom(agentId)).trim();
    if (reply) return reply;
    // Empty completion: a worker that genuinely did something — produced
    // text or ran a tool — anywhere in its transcript just wrote no closing
    // prose; that's progress, not failure. A worker with NEITHER is one that
    // never got going at all (harness likely out of usage or failed to
    // start) — an explicit failure, not a silent "(no final reply)" success.
    if (worker.active) return `(no final reply)\n\n${worker.digest}`;
    throw new Error(
      [worker.lastText || worker.failure || "worker produced no output — likely out of usage or failed to start", worker.digest].filter(Boolean).join("\n\n"),
    );
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
      let untrusted = false;
      try {
        const state = normalizeRoomState(await readJson(workspacePaths.roomState(this.workspace.rootDir, roomId)));
        record = state.summon;
        parentRoomId = state.parentRoomId;
        untrusted = state.summonUntrusted === true;
      } catch {
        continue;
      }
      if (!record || record.status !== "running" || !parentRoomId) continue;
      const info: SummonChild = { roomId, parentRoomId, agentId: record.agentId, prompt: "", untrusted };
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
    const worker = await inspectWorker(this.workspace.rootDir, info.roomId, info.agentId);
    const lastTask = (await child.getSnapshot()).tasks.at(-1);
    let reply: string;
    let failed: boolean;
    if (lastTask?.status === "error") {
      reply = [lastTask.error || worker.failure || "summon turn failed", worker.digest].filter(Boolean).join("\n\n");
      failed = true;
    } else if (lastTask?.status === "cancelled") {
      reply = ["cancelled before completion", worker.digest].filter(Boolean).join("\n\n");
      failed = true;
    } else {
      const raw = (await child.latestReplyFrom(info.agentId)).trim();
      if (raw) {
        reply = raw;
        failed = false;
      } else if (worker.active) {
        // Did something, wrote no closing prose — progress, not failure.
        reply = `(no final reply)\n\n${worker.digest}`;
        failed = false;
      } else {
        // Never got going at all — same empty-completion failure bar as
        // runFirstTurn.
        reply = [worker.lastText || worker.failure || "worker produced no output — likely out of usage or failed to start", worker.digest].filter(Boolean).join("\n\n");
        failed = true;
      }
    }
    await this.deliver(child, info, record, reply, failed);
  }
}
