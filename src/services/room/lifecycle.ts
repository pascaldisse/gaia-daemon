// RoomService bootstrap/lifecycle concern (JOB2 A6e): construction's runtime
// build, RoomService.open's room-resolution, initOnce's durable-state recovery
// pass, subscribe, and dispose. Extracted off room-service.ts's facade —
// see RoomLifecyclePort (ports.ts) for the narrow surface this reaches.

import { readJson } from "../../core/store.js";
import type { SanitizeProposal } from "../../core/types.js";
import type { UiEvent } from "../../core/types.js";
import { RoomHandle } from "../../domain/rooms.js";
import { resolveRoomWorkDir } from "../../domain/worktree.js";
import type { AgentRuntime } from "../../harness/spec.js";
import { createAgentRuntime } from "../../harness/host.js";
import { resolveSandboxPolicy } from "../../harness/sandbox/spec.js";
import { allowSummonForTurn, effectiveTrust } from "../summons.js";
import type { RoomServiceOptions } from "../room-service.js";
import type { RoomLifecycleConstructPort, RoomLifecyclePort } from "./ports.js";

/** Builds every agent's runtime at construction. allowSummon/sandbox/workDir
 * are lazy thunks reading `self` LIVE (RULE #0 — uniform for every harness):
 * isSummonRoom/summonUntrusted/workDir aren't known until initOnce() reads
 * RoomHandle.state(), and the thunks are only ever invoked later, at spawn. */
export function buildRoomRuntimes(
  options: RoomServiceOptions,
  incognito: boolean,
  self: RoomLifecycleConstructPort,
): Record<string, AgentRuntime> {
  return Object.fromEntries(
    Object.values(options.workspace.agents).map((agent) => [
      agent.id,
      options.runtimeFactory
        ? options.runtimeFactory(agent)
        : createAgentRuntime({
            workspace: options.workspace,
            agent,
            ...(incognito ? { incognito: true } : {}),
            memoryStore: options.memoryStore,
            harnessHost: options.harnessHost,
            // Resolved at spawn (after init), when parentRoomId and the
            // inherited untrusted tier are known.
            allowSummon: () => allowSummonForTurn(agent, self.isSummonRoom, self.summonUntrusted),
            sandbox: () =>
              resolveSandboxPolicy(options.workspace.config.sandbox, agent.sandbox, self.isSummonRoom, {
                trusted: effectiveTrust(agent, self.summonUntrusted),
              }),
            workDir: () => self.workDir,
          }),
    ]),
  );
}

/** RoomService.open's room-resolution step: derive the room id, open its
 * durable handle, and read the immutable incognito flag once (the constructor
 * strips memory/recall tools off that single read — see RoomServiceOptions
 * .incognito doc). */
export async function resolveRoomOpen(options: RoomServiceOptions): Promise<{ room: RoomHandle; incognito: boolean }> {
  const roomId = options.roomId ?? options.workspace.config.room;
  const room = await RoomHandle.open(options.workspace.rootDir, roomId);
  const incognito = options.incognito ?? (await room.state()).incognito === true;
  return { room, incognito };
}

/** Bootstrap/lifecycle mixin: durable-state recovery at open (initOnce),
 * subscribe, and dispose — run through the narrow RoomLifecyclePort, so it
 * carries zero harness knowledge (RULE #0). */
export class RoomLifecycle {
  constructor(private readonly service: RoomLifecyclePort) {}

  subscribe(listener: (event: UiEvent) => void): () => void {
    return this.service.bus.on(listener);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.service.authRetryTimer);
    this.service.authRetryTimer = undefined;
    await Promise.all(Object.values(this.service.runtimes).map((runtime) => runtime.dispose()));
  }

  async initOnce(): Promise<void> {
    const service = this.service;
    await Promise.all(Object.values(service.workspace.agents).map((agent) => service.options.memoryStore.init(agent.memoryDir, agent.displayName)));
    const state = await service.room.state();
    service.isSummonRoom = Boolean(state.parentRoomId);
    service.summonUntrusted = state.summonUntrusted === true;
    // This room's working directory: top-level rooms OWN a git worktree under
    // collab isolation (created here on first open); summon rooms INHERIT the
    // parent's (resolved + stamped at summon launch). A vanished dir degrades
    // to the workspace root instead of wedging every spawn on a dead cwd.
    service.workDir = await resolveRoomWorkDir(service.workspace.rootDir, service.workspace.config.collab, state, service.room.roomId);
    if (service.workDir && service.workDir !== state.workDir) {
      const dir = service.workDir;
      await service.room.updateState((s) => { s.workDir = dir; });
    }
    // Restore the per-agent context accounting so the composer's `ctx` chip is
    // present from first paint after a restart, not blank until the next turn.
    if (state.contextUsage) service.contextUsage = { ...state.contextUsage };
    // Reopen a held context-gate decision (the modal persists across a restart).
    service.contextGate = state.contextGate;

    // Surface a previously saved sanitize proposal (popup reopens after restart).
    // Only ACTIONABLE proposals are restored as pending: a review that returned
    // no output, didn't parse, or found nothing has 0 suggestions and can never
    // be applied, so it must not linger as a pending item that re-pops the popup
    // on every reload. The file stays on disk — reopening the popup manually
    // still shows Dario's raw notes.
    const savedProposal = (await readJson(service.sanitizeProposalPath)) as SanitizeProposal | null;
    if (savedProposal?.at && Array.isArray(savedProposal.suggestions) && savedProposal.suggestions.length > 0) {
      service.sanitizeStatus = {
        at: savedProposal.at,
        suggestions: savedProposal.suggestions.length,
        ...(savedProposal.appliedAt ? { appliedAt: savedProposal.appliedAt } : {}),
      };
    }

    // Interrupted turn? Resume in the background — never blocks opening.
    if (state.pendingTurn) void service.resumePendingTurn(state.pendingTurn).catch(() => {});
    // Durable queue survivors from a prior process: rebuild their task chips.
    // Voice-channel synthetics are dropped — their call is gone.
    const queue = state.queue ?? [];
    if (queue.length > 0) {
      const stale = queue.filter((message) => message.channel === "voice");
      if (stale.length > 0) {
        await service.room.updateState((current) => {
          current.queue = current.queue?.filter((message) => message.channel !== "voice");
          if (current.queue?.length === 0) delete current.queue;
        });
      }
      service.queuedTasks = queue
        .filter((message) => message.channel !== "voice")
        .map((message) => ({
          id: message.taskId,
          roomId: service.room.roomId,
          text: message.text,
          targets: message.targets,
          status: "queued" as const,
          startedAt: message.queuedAt,
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          // Agent-authored hand-offs/summon callbacks aren't "user →" ghosts.
          ...(message.fromAgentDialogue ? { callback: true } : {}),
        }));
    }

    // Goal recovery: every active goal owns either an in-flight WAL marker or
    // one durable queue entry. If a process died after committing a reply but
    // before enqueueing its successor, recreate that successor on boot.
    const goal = state.goal;
    const goalPending = goal && state.pendingTurn?.goalStartedAt === goal.startedAt;
    const goalQueued = goal && queue.some((message) => message.goalStartedAt === goal.startedAt);
    if (goal?.status === "active" && !goalPending && !goalQueued) {
      await service.enqueueGoalTurn(goal, true, !state.pendingTurn);
    } else if (!state.pendingTurn && service.queuedTasks.length > 0 && !service.activeTask) {
      void service.drain();
    }
  }
}
