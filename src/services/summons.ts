// Summons: an agent running in a child room. The coordinator owns only the
// cross-room piece (creating + linking child rooms, the per-room cap); the
// turn itself runs through the child room's own service — streaming,
// persistence, steering and recursion all come from the room machinery.
//
// Trust policy lives here too: one bit (`trust: false`) forces the sandbox and
// bars summoning; nested summons are default-deny.

import type { AgentDef, Workspace } from "../core/types.js";
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

/** What the coordinator needs from a room service (narrow, injectable). */
export interface SummonRoomAccess {
  sendMessage(text: string, options: { targets: string[] }): Promise<unknown>;
  waitForIdle(timeoutMs?: number): Promise<void>;
  latestReplyFrom(agentId: string): Promise<string>;
}

export interface SummonHost {
  /** Kick off a summon and return its child room id (fire-and-forget). */
  summon(parentRoomId: string, agentId: string, task: string): Promise<string>;
  /** Kick off and await the worker's final reply. */
  summonAndWait(parentRoomId: string, agentId: string, task: string): Promise<string>;
  /** Running summons; a parent room's direct children, or all when omitted. */
  runningChildren(parentRoomId?: string): SummonChild[];
}

/** A worker that runs longer than this stops being awaited; its turn keeps
 * going in its room and the result is read from the transcript later. */
export const SUMMON_TIMEOUT_MS = 300_000;

export class SummonCoordinator implements SummonHost {
  /** childRoomId -> info, for summons whose first turn is still running (the
   * cap + live snapshot). Completed summons live on as child rooms on disk. */
  private readonly running = new Map<string, SummonChild>();

  constructor(
    private readonly workspace: Workspace,
    private readonly workspacePath: string,
    private readonly serviceForRoom: (roomId: string) => Promise<SummonRoomAccess>,
    private readonly maxPerRoom: number,
  ) {}

  runningChildren(parentRoomId?: string): SummonChild[] {
    const all = [...this.running.values()];
    return parentRoomId === undefined ? all : all.filter((child) => child.parentRoomId === parentRoomId);
  }

  async summon(parentRoomId: string, agentId: string, task: string): Promise<string> {
    const { childRoomId } = await this.start(parentRoomId, agentId, task);
    return childRoomId;
  }

  async summonAndWait(parentRoomId: string, agentId: string, task: string): Promise<string> {
    const { done } = await this.start(parentRoomId, agentId, task);
    return done;
  }

  private async start(parentRoomId: string, agentId: string, task: string): Promise<{ childRoomId: string; done: Promise<string> }> {
    if (!this.workspace.agents[agentId]) throw new Error(`Unknown agent: @${agentId}`);
    if (this.runningChildren(parentRoomId).length >= this.maxPerRoom) {
      throw new Error(`Too many running summons in room ${parentRoomId}; wait for one to finish or cancel it first.`);
    }

    const childRoomId = `${agentId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
    await ensureWorkspaceRoom(this.workspacePath, childRoomId);

    // Stamp the parent link BEFORE the child service reads state at init, so it
    // survives the service's own state writes (and the rooms tree sees it).
    const statePath = workspacePaths.roomState(this.workspace.rootDir, childRoomId);
    const state = normalizeRoomState(await readJson(statePath));
    state.parentRoomId = parentRoomId;
    await writeJsonAtomic(statePath, state);

    const child = await this.serviceForRoom(childRoomId);
    const info: SummonChild = { roomId: childRoomId, parentRoomId, agentId, prompt: task };
    this.running.set(childRoomId, info);

    const done = this.runFirstTurn(child, agentId, task).finally(() => this.running.delete(childRoomId));
    // Don't crash on fire-and-forget summons whose result no one awaits.
    done.catch(() => {});
    return { childRoomId, done };
  }

  private async runFirstTurn(child: SummonRoomAccess, agentId: string, task: string): Promise<string> {
    await child.sendMessage(task, { targets: [agentId] });
    try {
      await child.waitForIdle(SUMMON_TIMEOUT_MS);
    } catch {
      return `summon timed out after ${Math.round(SUMMON_TIMEOUT_MS / 60_000)} minutes`;
    }
    const reply = (await child.latestReplyFrom(agentId)).trim();
    return reply || "(no output)";
  }
}
