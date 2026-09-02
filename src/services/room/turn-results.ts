import type { ActiveContextRef } from "../../domain/workspace-index.js";
import type { AgentDef, EventDetails, MessageAttachment, PendingTurn, RoomEvent, RoomEventKind, Task } from "../../core/types.js";
import type { RenderCap } from "../../domain/render-cap.js";
import type { EpisodeCapture } from "../memory-service.js";
import { newId } from "../../core/ids.js";
import type { SendMessageOptions } from "../room-service.js";
import { RoomTurnLoop } from "./turn-loop.js";
import * as contextGate from "./context-gate.js";
import type { RoomTurnResultsPort } from "./ports.js";

/** Turn result persistence, retry markers, and context-gate delegation. */
export class RoomTurnResults {
  constructor(private readonly service: RoomTurnResultsPort) {}

  async runAgentTask(task: Task, text: string, options: SendMessageOptions): Promise<void> {
    return new RoomTurnLoop(this.service).runAgentTask(task, text, options);
  }

  contextFor(agent: AgentDef): { usedTokens: number; maxTokens?: number } | undefined {
    return new RoomTurnLoop(this.service).contextFor(agent);
  }

  // --- context gate ----------------------------------------------------------

  async openContextGate(agent: AgentDef, message: string, estTokens: number, totalEvents: number, attachments: MessageAttachment[] | undefined, reason: "new-agent" | "session-lost"): Promise<void> {
    return contextGate.openContextGate(this.service, agent, message, estTokens, totalEvents, attachments, reason);
  }

  async resolveContextGate(choice: "full" | "last" | "compact", n?: number): Promise<void> {
    return contextGate.resolveContextGate(this.service, choice, n);
  }

  async setContextFloor(agentId: string, floorIdx: number): Promise<void> {
    return contextGate.setContextFloor(this.service, agentId, floorIdx);
  }

  async recallContext(agentId: string): Promise<ActiveContextRef> {
    return contextGate.recallContext(this.service, agentId);
  }

  async summarizeRoom(target: string, uptoEvents: number): Promise<string> {
    return contextGate.summarizeRoom(this.service, target, uptoEvents);
  }

  /** WAL step 2: append the reply event (details ON it), then one atomic state
   * write clearing the marker and advancing the cursor. */
  /** `renderCap`, when given, is a command-plugin's display-time cap resolved
   * for THIS turn (services/plugins.ts CommandPlugin.renderCap) — persisted
   * on the event verbatim alongside the agent's FULL, untruncated `reply`
   * text (root-cause fix, Pascal, 2026-08-23: the event committed/stored here
   * must never be shorter than what the agent actually said). Only the
   * LIVE-emitted copy's `text` is capped, via displayEventText — and, when
   * `renderCap.note` is set, a SEPARATE synthesized system-authored chrome
   * event is emitted right after it (see withRenderCapNotes) — matching every
   * other display surface (#getSnapshot, #eventById(display:true)) that
   * derives the same shown output from the same stored (text, renderCap)
   * pair on demand. */
  async commitReply(
    agentId: string,
    eventId: string,
    reply: string,
    details: EventDetails,
    channel: "voice" | undefined,
    nextPending?: PendingTurn,
    renderCap?: RenderCap,
  ): Promise<void> {
    // Blocks count only when they encode structure the plain reply text doesn't
    // already carry (a steer marker, a tool, a thinking span) — a prose-only
    // turn stays detail-less exactly as before, so nothing bloats.
    const hasDetails =
      details.model ||
      details.thinkingStarted ||
      details.thinking ||
      details.tools?.length ||
      details.blocks?.some((block) => block.kind !== "text");
    const event: RoomEvent = {
      id: eventId,
      timestamp: new Date().toISOString(),
      author: agentId,
      text: reply,
      ...(channel ? { channel } : {}),
      ...(hasDetails ? { details } : {}),
      ...(renderCap ? { renderCap } : {}),
    };
    // commitTurn computes the cursor from the reply's own line (sweeping the
    // mid-turn steers/notes the live turn already saw) and, for a multi-target
    // turn, installs the next target's marker in the same atomic write. Always
    // the FULL text — storage/memory/hooks/agent-context never see a capped
    // reply, only display surfaces do.
    await this.service.room.commitTurn(event, nextPending);
    for (const displayEvent of this.service.withRenderCapNotes([event])) {
      this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event: displayEvent });
    }
  }

  /** Durable failure marker: a turn that dies must leave a trace in the
   * transcript, not just the ephemeral task-error toast (which vanishes on the
   * next reload — the poisoned-gateway incident left rooms full of failed
   * turns with zero on-disk evidence). Authored by "system" so it renders as a
   * system line and stays out of every agent's context. Best-effort: marking
   * the failure must never mask the failure itself.
   *
   * `kind: "turn-failed"` is the ONLY signal the client needs to offer a resend
   * — it means the user message right before this row got NO reply at all
   * (producedOutput was false at the call site). Without it, the transcript's ⟳
   * only ever appears on an agent reply, so a reply-less failed turn had no
   * fork-based recovery and users retyped the same text into the composer,
   * which appends a brand-new user event instead of regenerating (the
   * duplicate-resend bug). retryMessage(eventId) on THIS event's id already
   * resolves correctly — forkAtUserMessage walks backward past non-user authors
   * to the user message that produced it. */
  async appendTurnFailure(agentId: string, error: unknown): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      const event: RoomEvent = {
        id: newId("system_turnfail"),
        timestamp: new Date().toISOString(),
        author: "system",
        kind: "turn-failed",
        text: `⚠ turn failed (@${agentId}): ${message}`,
      };
      await this.service.room.appendEvent(event);
      this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
    } catch {
      // The task-error path still surfaces the original error live.
    }
  }

  /** Durable persistence for a manifest-registry command's system-authored
   * reply, OR a capability denial converted to one (ADV-021) — same
   * append-under-room-lock protocol as appendTurnFailure/appendTurnStopped
   * just below, replacing RoomQueue#sendMessage's old transient-only
   * `emit({type:"room-event"})` (in-memory, lost on crash/reconnect-miss:
   * REFACTOR-BUGS.md ADV-021). `details`, when given, carries structured
   * provenance (e.g. `pluginDenial`) alongside the human-readable `text`.
   * Returns the committed event so the caller can drive its own task-status
   * bookkeeping without a second read. */
  async appendPluginEvent(text: string, kind: RoomEventKind, details?: EventDetails): Promise<RoomEvent> {
    const event: RoomEvent = {
      id: newId("system_plugin"),
      timestamp: new Date().toISOString(),
      author: "system",
      kind,
      text,
      ...(details ? { details } : {}),
    };
    await this.service.room.appendEvent(event);
    this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
    return event;
  }

  /** Quiet counterpart to appendTurnFailure for user cancels that beat the
   * first token: a stop is not a failure. */
  async appendTurnStopped(agentId: string): Promise<void> {
    try {
      const event: RoomEvent = {
        id: newId("system_turnfail"),
        timestamp: new Date().toISOString(),
        author: "system",
        text: `■ turn stopped (@${agentId}) — no output yet`,
      };
      await this.service.room.appendEvent(event);
      this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
    } catch {
      // The task-error path still surfaces the original error live.
    }
  }

  /** Requeue-once after RunnerHost's hard stall deadline aborted the turn
   * (a named UpstreamStallError — src/harness/host.ts): a stalled turn that
   * produced no reply text gets exactly ONE automatic retry, through the same
   * durable queue every other queued message uses, marked `stallRetried` so a
   * SECOND stall on the retry falls through to the normal failure path
   * instead of keeping a dead upstream's retry loop alive forever. Returns
   * true when it requeued — the caller then skips its generic
   * appendTurnFailure in favor of the more specific system line this appends.
   * No-op (false) for any other error, a non-empty partial (current commit +
   * failure behavior is unchanged), or a turn that was itself a stall retry. */
  async maybeRequeueStall(
    targets: string[],
    agentId: string,
    text: string,
    error: unknown,
    partialReply: string,
    channel: "voice" | undefined,
    attachments: MessageAttachment[] | undefined,
    options: SendMessageOptions,
  ): Promise<boolean> {
    const isStall = error instanceof Error && error.name === "UpstreamStallError";
    if (!isStall || partialReply.trim() || options.queued?.stallRetried) return false;
    const event: RoomEvent = {
      id: newId("system_stallretry"),
      timestamp: new Date().toISOString(),
      author: "system",
      text: `⚠ turn aborted after upstream stall (@${agentId}) — message requeued, retrying once`,
    };
    await this.service.room.appendEvent(event);
    this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
    const retryTask = this.service.createTask(text, targets);
    retryTask.status = "queued";
    await this.service.room.enqueue({
      taskId: retryTask.id,
      text,
      targets,
      ...(channel ? { channel } : {}),
      ...(attachments?.length ? { attachments } : {}),
      stallRetried: true,
      queuedAt: retryTask.startedAt,
    });
    this.service.queuedTasks.push(retryTask);
    this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task: retryTask });
    void this.service.emitSnapshot();
    return true;
  }

  async maybeRequeueAuth(
    targets: string[],
    agentId: string,
    text: string,
    error: unknown,
    _partialReply: string,
    channel: "voice" | undefined,
    attachments: MessageAttachment[] | undefined,
    options: SendMessageOptions,
  ): Promise<boolean> {
    const isAuth = error instanceof Error && error.name === "TransientAuthError";
    const attempt = (options.queued?.authRetries ?? 0) + 1;
    if (!isAuth || attempt > 5) return false;
    const backoff = [30_000, 60_000, 120_000, 300_000, 600_000][attempt - 1];
    const event: RoomEvent = {
      id: newId("system_authretry"),
      timestamp: new Date().toISOString(),
      author: "system",
      text: `⚠ turn failed on transient auth (@${agentId}) — requeued, retry ${attempt}/5 in ${backoff / 1000}s`,
    };
    await this.service.room.appendEvent(event);
    this.service.emit({ type: "room-event", workspaceId: this.service.workspaceId, roomId: this.service.roomId, event });
    const retryTask = this.service.createTask(text, targets);
    retryTask.status = "queued";
    await this.service.room.enqueue({
      taskId: retryTask.id,
      text,
      targets,
      ...(channel ? { channel } : {}),
      ...(attachments?.length ? { attachments } : {}),
      authRetries: attempt,
      notBefore: new Date(Date.now() + backoff).toISOString(),
      queuedAt: retryTask.startedAt,
    });
    this.service.queuedTasks.push(retryTask);
    this.service.emit({ type: "task-start", workspaceId: this.service.workspaceId, roomId: this.service.roomId, task: retryTask });
    void this.service.emitSnapshot();
    return true;
  }

  /** Episodic capture is best-effort derived data: a failure must never fail
   * the turn that produced it. */
  async captureEpisode(
    agentId: string,
    task: string,
    reply: string,
    outcome: EpisodeCapture["outcome"],
    details: EventDetails,
    channel: "voice" | undefined,
  ): Promise<void> {
    if (!this.service.options.memory) return;
    // Incognito rooms leave no episodic trace: nothing from a turn here is ever
    // captured into memory (guards all captureEpisode call sites at once).
    if (this.service.incognito) return;
    const tools = [...new Set((details.tools ?? []).map((tool) => tool.toolName))];
    try {
      await this.service.options.memory.capture(agentId, {
        roomId: this.service.roomId,
        task,
        reply,
        outcome,
        ...(tools.length ? { tools } : {}),
        ...(channel ? { channel } : {}),
      });
    } catch {
      // Derived data; the transcript already has the full turn.
    }
  }

}
