import type { AgentDefinition } from "../agents/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import {
  appendSummonEvent,
  createSummonSession,
  listSummonSessions,
  readSummonEvents,
  readSummonResult,
  updateSummonSession,
  writeSummonResult,
  type SummonSession,
  type SummonEvent,
} from "../room/summons.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { Workspace } from "../workspace/types.js";
import type { GaiaUiEvent } from "./gaia-controller.js";

export type SummonRuntimeEvent =
  | { type: "summon-start"; workspaceId: string; roomId: string; session: SummonSession }
  | { type: "summon-event"; workspaceId: string; roomId: string; summonId: string; agentId: string; event: SummonEvent }
  | { type: "summon-end"; workspaceId: string; roomId: string; session: SummonSession };

export interface SummonManagerOptions {
  maxRunningPerRoom?: number;
}

const DEFAULT_MAX_RUNNING_PER_ROOM = 3;

export class SummonManager {
  private readonly sessions = new Map<string, SummonSession>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly endWaiters = new Map<string, Set<(session: SummonSession) => void>>();
  private readonly maxRunningPerRoom: number;

  constructor(
    private readonly workspaceId: string,
    private readonly workspace: Workspace,
    private readonly runtimeFactory: (agent: AgentDefinition) => AgentRuntime,
    private readonly emit: (event: GaiaUiEvent) => void,
    private readonly memoryStore: MemoryStore,
    options: SummonManagerOptions = {},
  ) {
    this.maxRunningPerRoom = options.maxRunningPerRoom ?? DEFAULT_MAX_RUNNING_PER_ROOM;
  }

  async create(roomId: string, agentId: string, task: string): Promise<SummonSession> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(`Unknown agent: @${agentId}`);
    const runningForRoom = [...this.sessions.values()].filter(
      (session) => session.roomId === roomId && session.status === "running",
    ).length;
    if (runningForRoom >= this.maxRunningPerRoom) {
      throw new Error(`Too many running summons in room ${roomId}; wait for one to finish or cancel it first.`);
    }

    const harness = agent.harness ?? this.workspace.config.harness ?? "pi";
    const session = await createSummonSession({
      roomsDir: this.workspace.roomsDir,
      roomId,
      agentId,
      harness,
      prompt: task,
    });

    this.sessions.set(session.id, session);

    const runtimeEvent: SummonRuntimeEvent = {
      type: "summon-start",
      workspaceId: this.workspaceId,
      roomId,
      session,
    };
    this.emit(runtimeEvent as unknown as GaiaUiEvent);

    // Run the summon asynchronously so the caller gets the session id immediately.
    void this.runSummon(session, agent, task, roomId).catch(() => {
      // Errors are handled inside runSummon.
    });

    return session;
  }

  private async runSummon(session: SummonSession, agent: AgentDefinition, task: string, roomId: string): Promise<void> {
    let runtime: AgentRuntime;
    try {
      runtime = this.runtimeFactory(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failSummon(session, message);
      return;
    }

    this.runtimes.set(session.id, runtime);
    let reply = "";

    try {
      // Initialize memory for the agent if needed (same path as GaiaController.init).
      await this.memoryStore.init(agent.memoryDir, agent.displayName);

      for await (const agentEvent of runtime.send({
        roomId,
        message: task,
        transcript: [],
      })) {
        if (session.status !== "running") break;

        if (agentEvent.type === "text-delta") reply += agentEvent.delta;

        const summonEvent = this.toSummonEvent(agentEvent);
        await appendSummonEvent(session.logPath, summonEvent);

        const rtEvent: SummonRuntimeEvent = {
          type: "summon-event",
          workspaceId: this.workspaceId,
          roomId,
          summonId: session.id,
          agentId: agent.id,
          event: summonEvent,
        };
        this.emit(rtEvent as unknown as GaiaUiEvent);
      }

      if (session.status !== "running") return;

      const summary = reply.trim() || "(no output)";
      await writeSummonResult(session.logPath, summary);
      const updated = await updateSummonSession(session.logPath, {
        status: "complete",
        endedAt: new Date().toISOString(),
        summary,
      });
      Object.assign(session, updated);

      this.emitSummonEnd(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failSummon(session, message);
    } finally {
      runtime.dispose();
      this.runtimes.delete(session.id);
    }
  }

  private async failSummon(session: SummonSession, error: string): Promise<void> {
    const summary = `Error: ${error}`;
    await writeSummonResult(session.logPath, summary);
    const updated = await updateSummonSession(session.logPath, {
      status: "error",
      endedAt: new Date().toISOString(),
      summary,
    });
    Object.assign(session, updated);
    this.emitSummonEnd(updated);
  }

  async cancel(summonId: string): Promise<SummonSession | undefined> {
    const session = this.sessions.get(summonId);
    if (!session || session.status !== "running") return undefined;

    const runtime = this.runtimes.get(summonId);
    if (runtime) await runtime.abort();

    const updated = await updateSummonSession(session.logPath, {
      status: "cancelled",
      endedAt: new Date().toISOString(),
    });
    Object.assign(session, updated);
    this.emitSummonEnd(updated);
    return session;
  }

  get(summonId: string): SummonSession | undefined {
    return this.sessions.get(summonId);
  }

  /** True while any summon for this manager is still running. */
  hasRunning(): boolean {
    for (const session of this.sessions.values()) {
      if (session.status === "running") return true;
    }
    return false;
  }

  /** Running and recently completed summons for a room (capped at 50). */
  list(roomId: string): SummonSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.roomId === roomId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 50);
  }

  async listStored(roomId: string): Promise<SummonSession[]> {
    const stored = await listSummonSessions(this.workspace.roomsDir, roomId);
    const merged = new Map(stored.map((session) => [session.id, session]));
    for (const session of this.list(roomId)) merged.set(session.id, session);
    return [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
  }

  async details(roomId: string, summonId: string): Promise<{ session: SummonSession; events: SummonEvent[]; result: string } | undefined> {
    const session = this.sessions.get(summonId) ?? (await this.listStored(roomId)).find((candidate) => candidate.id === summonId);
    if (!session) return undefined;
    return {
      session,
      events: await readSummonEvents(session.logPath),
      result: await readSummonResult(session.logPath),
    };
  }

  async waitForEnd(summonId: string, timeoutMs: number): Promise<SummonSession | undefined> {
    const current = this.sessions.get(summonId);
    if (current && current.status !== "running") return current;

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        const waiters = this.endWaiters.get(summonId);
        waiters?.delete(resolveWaiter);
        if (waiters?.size === 0) this.endWaiters.delete(summonId);
      };
      const resolveWaiter = (session: SummonSession) => {
        cleanup();
        resolve(session);
      };

      let waiters = this.endWaiters.get(summonId);
      if (!waiters) {
        waiters = new Set();
        this.endWaiters.set(summonId, waiters);
      }
      waiters.add(resolveWaiter);

      timeout = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.sessions.clear();
    this.endWaiters.clear();
  }

  private emitSummonEnd(session: SummonSession): void {
    this.emit({
      type: "summon-end",
      workspaceId: this.workspaceId,
      roomId: session.roomId,
      session,
    } as unknown as GaiaUiEvent);

    const waiters = this.endWaiters.get(session.id);
    if (!waiters) return;
    this.endWaiters.delete(session.id);
    for (const waiter of waiters) waiter(session);
  }

  private toSummonEvent(event: import("../runtime/types.js").AgentEvent): SummonEvent {
    switch (event.type) {
      case "model-info":
        return { type: "model-info", provider: event.provider, modelId: event.modelId, subscription: event.subscription };
      case "text-delta":
        return { type: "text-delta", delta: event.delta };
      case "thinking-start":
        return { type: "thinking-start" };
      case "thinking-delta":
        return { type: "thinking-delta", delta: event.delta };
      case "thinking-end":
        return { type: "thinking-end", content: event.content };
      case "tool-start":
        return { type: "tool-start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
      case "tool-update":
        return { type: "tool-update", toolName: event.toolName, toolCallId: event.toolCallId, partialResult: event.partialResult };
      case "tool-end":
        return { type: "tool-end", toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
    }
  }
}
