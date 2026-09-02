// @ts-nocheck
import { hasExplicitMention } from "../commands.js";
import type { MessageAttachment, Task } from "../../core/types.js";

/** Transcript truncation, retry, edit, and harness-session rewind path. */
export class RoomFork {
  constructor(private readonly service: any) {}
  async retryMessage(eventId: string): Promise<Task> {
    const origin = await this.forkAtUserMessage(eventId);
    return this.service.sendMessage(origin.text, {
      ...(origin.targets.length ? { targets: origin.targets } : {}),
      ...(origin.attachments?.length ? { attachments: origin.attachments } : {}),
    });
  }

  /** Edit a user message: fork the room at that message and re-run with the
   * new text. An explicit @mention in the edited text wins; otherwise the
   * original routing is kept. Original attachments ride along by default
   * (claude.ai edit semantics: the text changes, the files stay) — UNLESS
   * `keepAttachmentPaths` is given, in which case only origin attachments
   * whose path is in that list survive (an empty array drops them all). This
   * only ever narrows the origin's own trusted attachment list — it can
   * never attach a path the message didn't already have. */
  async editMessage(eventId: string, text: string, keepAttachmentPaths?: string[]): Promise<Task> {
    const origin = await this.forkAtUserMessage(eventId);
    const mentioned = hasExplicitMention(text, new Set(Object.keys(this.service.workspace.agents)));
    const attachments = keepAttachmentPaths ? origin.attachments?.filter((a) => keepAttachmentPaths.includes(a.path)) : origin.attachments;
    return this.service.sendMessage(text, {
      ...(!mentioned && origin.targets.length ? { targets: origin.targets } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
  }

  /** The fork-from-message primitive behind edit and retry: truncate the
   * transcript at the originating USER message (dropped events are preserved
   * in rewound.jsonl) and cap cursors that pointed past the cut. Claude.ai-style
   * "edit deletes the rest" — except nothing is actually lost. Uniform for every
   * harness: the room WAL is the fork; native session forks are never used.
   *
   * The harness session MUST reset here ("reset-keep-context"). A long-lived
   * session (e.g. claude --resume) keeps its OWN copy of the conversation, so
   * truncating only the gaia transcript leaves every rewound turn alive inside
   * the session — the model still sees the deleted resends and its own prior
   * replies, and the "edit" reads to it as one more identical message appended
   * after them. That is the refusal-loop bug: nothing before the fork actually
   * changes for the model, so it never moves off its last answer. Resetting the
   * session (then replaying the whole KEPT conversation from the floor) is what
   * makes edit/retry mean what a user expects: everything after the fork is gone
   * from the model's view too, not just from the sidebar. Context is preserved
   * in full (replay from the floor), so the regenerated reply still knows the
   * whole conversation up to the edited message — the reset only drops the tail. */
  private async forkAtUserMessage(eventId: string): Promise<{ text: string; targets: string[]; attachments?: MessageAttachment[] }> {
    if (this.service.activeTask) throw new Error("A turn is running — cancel it first, then edit or retry.");
    const { events } = await this.service.room.eventsFrom(0);
    let index = events.findIndex((event) => event.id === eventId);
    if (index < 0) throw new Error("Message not found in this room's transcript.");
    while (index >= 0 && events[index].author !== "user") index--;
    if (index < 0) throw new Error("No user message precedes that event to fork from.");
    const origin = events[index];
    // The origin's 1-based ordinal among USER-authored messages, computed from
    // the FULL pre-rewind events list (rewindToEvent below drops the origin, so
    // its position is unrecoverable after). A native-fork harness (pi) maps
    // this to the Kth of its own ordered user entries — position, never text,
    // because pi stores the buildTurnPrompt-wrapped prompt, not gaia's raw
    // event text (text matching always missed → silent fallback, the live-test
    // bug). Assumes 1:1 gaia-user-turn ↔ harness-user-entry (one user message =
    // one prompt); an agent-to-agent turn or a recorded mid-turn steer could
    // desync it — out of scope, and a wrong ordinal only mis-targets the branch
    // (the {ok:false} fallback still protects correctness).
    const userOrdinal = events.slice(0, index + 1).filter((event) => event.author === "user").length;
    await this.service.room.rewindToEvent(origin.id);
    await this.resetAfterTruncation("reset-keep-context", undefined, { id: origin.id, userOrdinal });
    return {
      text: origin.text,
      targets: "targets" in origin ? origin.targets : [],
      ...("attachments" in origin && origin.attachments?.length ? { attachments: origin.attachments } : {}),
    };
  }

  /** After a transcript truncation or in-place rewrite. Agents whose cursor
   * never reached the cut are untouched either way — their session saw none of
   * the changed events, so resetting them is pure loss (this used to wipe EVERY
   * agent's session and then trip the session-lost gate on a simple retry).
   *
   * BOTH modes reset the harness session of every agent that read past the cut —
   * a long-lived session (claude --resume, codex rollout) keeps its own copy of
   * the conversation, so leaving it alive would let the removed/rewritten turns
   * survive inside it even after the gaia transcript changed. What differs is
   * whether earlier context is kept:
   *  - "reset-sessions" (rewind — forgetting IS the point): cursor AND context
   *    floor land on a recent windowed base, so the next turn replays only the
   *    kept window (deliberate amnesia, no session-lost gate).
   *  - "reset-keep-context" (edit / retry / sanitize — the tail must vanish but
   *    earlier context stays): the cursor reseeds to the agent's EXISTING floor
   *    (a /compact boundary, or 0) so the WHOLE kept conversation replays with
   *    the fork/rewrite applied — never a shrunken window. The floor is left
   *    exactly as it was. For edit/retry the dropped tail (resends + prior
   *    replies) is gone from the model's view; for sanitize the rewritten
   *    sentences replace the originals in place. Either way the reset drops only
   *    what changed, and the regenerated reply still knows everything up to the
   *    fork point.
   *
   * `cut` is the first transcript index whose content changed. Truncations
   * (edit/retry/rewind) omit it → the whole tail past `kept` is affected; sanitize
   * passes the index of the first REWRITTEN event — its events survive in place,
   * but any session that read past that point holds the original text and must be
   * treated as affected.
   *
   * `forkOrigin` (edit/retry only — see forkAtUserMessage) identifies the gaia
   * user message the fork landed on: its id (for logging) and `userOrdinal`
   * (its 1-based position among the room's user messages). For an affected
   * agent whose runtime declares capabilities.supportsForkAtMessage (pi), we
   * call runtime.forkAtMessage INSTEAD of resetRoom(): the harness's OWN
   * session is durably branched at the Kth user entry, so it already holds the
   * correct trimmed context and the cursor can advance straight to the fork
   * point — no resetRoom, no full-floor replay. Gated purely on the capability
   * flag, never a harness-id branch (AGENTS.md §RULE #0). A harness without the
   * capability (claude/codex), or a forkAtMessage call that fails, keeps the
   * exact existing resetRoom() + floor-replay path — fail-safe. */
  async resetAfterTruncation(
    mode: "reset-sessions" | "reset-keep-context",
    cut?: number,
    forkOrigin?: { id: string; userOrdinal: number },
  ): Promise<void> {
    const kept = (await this.service.room.transcriptCursor()) ?? 0;
    const affectedAbove = Math.min(cut ?? kept, kept);
    const base = Math.max(0, kept - this.service.workspace.config.transcriptWindow);
    const state = await this.service.room.state();
    // Agents whose own harness natively forked: their session already reflects
    // state through the fork point, so their cursor advances there directly
    // below instead of replaying from the floor.
    const forked = new Set<string>();
    for (const [id, cursor] of Object.entries(state.agentCursors)) {
      if (cursor <= affectedAbove) continue;
      const runtime = this.service.runtimes[id];
      if (mode === "reset-keep-context" && forkOrigin && runtime?.capabilities.supportsForkAtMessage && runtime.forkAtMessage) {
        const result = await runtime.forkAtMessage(this.service.roomId, forkOrigin.id, forkOrigin.userOrdinal);
        if (result.ok) {
          forked.add(id);
          continue;
        }
        // Native fork failed (ordinal out of range, unsupported session build,
        // stalled runner, …) — fall through to the fail-safe reset below.
      }
      runtime?.resetRoom(this.service.roomId);
    }
    // rewind moves the floor to a fresh window base — any durable compaction
    // summary captured at the old floor is now stale and must be dropped (its
    // floorIdx would no longer match anyway; clearing keeps the store honest).
    const forgot: string[] = [];
    await this.service.room.updateState((current) => {
      for (const [id, cursor] of Object.entries(current.agentCursors)) {
        if (cursor <= affectedAbove) continue;
        if (forked.has(id)) {
          // The harness's own session already holds the forked context up to
          // the fork point (this message is about to be re-sent and appended
          // right after it) — advance the cursor there directly.
          current.agentCursors[id] = kept;
        } else if (mode === "reset-sessions") {
          current.agentCursors[id] = base;
          current.contextFloors = { ...(current.contextFloors ?? {}), [id]: base };
          forgot.push(id);
        } else {
          // Keep the FULL context. Reseed to the agent's real floor so the entire
          // kept conversation replays on the fresh session — capped to `kept` so a
          // floor set past the fork (a /compact between fork point and tail) can't
          // land the cursor beyond the transcript end.
          current.agentCursors[id] = Math.min(current.contextFloors?.[id] ?? 0, kept);
        }
      }
      delete current.runtimeDetails;
    });
    for (const id of forgot) await this.service.room.clearCompaction(id);
    this.service.recentTasks = [];
    await this.service.emitSnapshot();
  }

}
