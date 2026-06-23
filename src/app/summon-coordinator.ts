import { readRoomState, roomStatePath, writeRoomState } from "../room/state.js";
import { ensureWorkspaceRoom } from "../workspace/workspace-loader.js";
import type { Workspace } from "../workspace/types.js";
import type { GaiaController } from "./gaia-controller.js";

// A summon is just an agent running in a child room. The coordinator owns the
// cross-room piece the daemon already has (per-room controllers): it creates the
// child room, links it to its parent, and runs the first turn through the
// child's OWN controller via the normal send path — so streaming, persistence,
// steering and recursion all come from the room machinery, not a parallel
// runner. Replaces the former bespoke SummonManager.

export interface SummonChild {
  /** The child room the summon runs in. */
  roomId: string;
  /** The room that spawned it (drives the nested rooms tree). */
  parentRoomId: string;
  agentId: string;
  prompt: string;
}

// Controller-facing handle; injected into each room controller so /summon, the
// Pi summon tool, and the `gaia summon` CLI all reach the same coordinator.
export interface SummonHost {
  /** Kick off a summon and return its child room id (fire-and-forget). */
  summon(parentRoomId: string, agentId: string, task: string): Promise<string>;
  /** Kick off and await the worker's final reply (Pi tool / gaia summon). */
  summonAndWait(parentRoomId: string, agentId: string, task: string): Promise<string>;
  /** Running summons; a parent room's direct children, or all when omitted. */
  runningChildren(parentRoomId?: string): SummonChild[];
}

// A worker that runs longer than this stops being awaited; its turn keeps
// going in its room and the result is read from the transcript on next open.
const SUMMON_TIMEOUT_MS = 300_000;

export class SummonCoordinator {
  // childRoomId -> info, for summons whose first turn is still running. Used for
  // the per-room cap and the live snapshot; completed summons live on as child
  // rooms on disk (the nested rooms tree), not here.
  private readonly running = new Map<string, SummonChild>();

  constructor(
    private readonly workspace: Workspace,
    private readonly workspacePath: string,
    private readonly controllerForRoom: (roomId: string) => Promise<GaiaController>,
    private readonly maxPerRoom: number,
  ) {}

  runningChildren(parentRoomId?: string): SummonChild[] {
    const all = [...this.running.values()];
    return parentRoomId === undefined ? all : all.filter((child) => child.parentRoomId === parentRoomId);
  }

  // Cancel a running summon by aborting its child room's turn. The room (and its
  // transcript so far) persists; it just stops streaming.
  async cancel(childRoomId: string): Promise<boolean> {
    if (!this.running.has(childRoomId)) return false;
    const child = await this.controllerForRoom(childRoomId);
    await child.cancelActiveTask();
    this.running.delete(childRoomId);
    return true;
  }

  async summon(parentRoomId: string, agentId: string, task: string): Promise<string> {
    const { childRoomId } = await this.start(parentRoomId, agentId, task);
    return childRoomId;
  }

  async summonAndWait(parentRoomId: string, agentId: string, task: string): Promise<string> {
    const { done } = await this.start(parentRoomId, agentId, task);
    return done;
  }

  // Create the child room, link it to its parent, and run the first turn through
  // the child's own controller. Returns the child room id immediately plus a
  // promise for the worker's final reply.
  private async start(parentRoomId: string, agentId: string, task: string): Promise<{ childRoomId: string; done: Promise<string> }> {
    if (!this.workspace.agents[agentId]) throw new Error(`Unknown agent: @${agentId}`);
    if (this.runningChildren(parentRoomId).length >= this.maxPerRoom) {
      throw new Error(`Too many running summons in room ${parentRoomId}; wait for one to finish or cancel it first.`);
    }

    const childRoomId = `${agentId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
    await ensureWorkspaceRoom(this.workspacePath, childRoomId);

    // Stamp the parent link BEFORE the child controller reads state at init, so
    // it survives the controller's own state writes (and the nested rooms tree
    // sees it).
    const statePath = roomStatePath(this.workspace.roomsDir, childRoomId);
    const state = await readRoomState(statePath);
    state.parentRoomId = parentRoomId;
    await writeRoomState(statePath, state);

    const child = await this.controllerForRoom(childRoomId);
    const info: SummonChild = { roomId: childRoomId, parentRoomId, agentId, prompt: task };
    this.running.set(childRoomId, info);

    const done = this.runFirstTurn(child, agentId, task).finally(() => this.running.delete(childRoomId));
    // Don't crash on fire-and-forget summons whose result no one awaits.
    done.catch(() => {});
    return { childRoomId, done };
  }

  private async runFirstTurn(child: GaiaController, agentId: string, task: string): Promise<string> {
    await child.sendMessage(task, { targets: [agentId] });
    try {
      await child.waitForIdle(SUMMON_TIMEOUT_MS);
    } catch {
      return "summon timed out after 5 minutes";
    }
    const reply = (await child.latestReplyFrom(agentId)).trim();
    return reply || "(no output)";
  }
}
