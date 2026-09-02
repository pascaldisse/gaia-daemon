// @ts-nocheck
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


const RECALL_COMMAND_LIMIT = 8;
const SANITIZE_REVIEW_CHAR_BUDGET = 160_000;
const PERSONA_CONTEXT_CAP = 16_000;
type CommandReply = string | { text: string; kind?: RoomEventKind; author?: string };
type RoomCommand = SlashCommand;
export class RoomSanitizeMixin {
  [key: string]: any;
  async sanitizePreview(): Promise<SanitizeProposal> {
    const host = this.options.summonHost;
    if (!host) throw new Error("Summons are not available in this workspace — the reviewer needs them to run.");
    if (!this.workspace.agents[SANITIZE_REVIEWER_ID]) {
      throw new Error(`No "${SANITIZE_REVIEWER_ID}" persona is loaded — restart the daemon to seed it, then retry.`);
    }
    // Review the SAME context the flagged agent replays — the whole span from
    // its context floor to the end — NOT a short tail. The classifier re-scores
    // that entire span every turn, and the drift onto the sensitive topic often
    // starts many turns back (a user question before the model ever refused), so
    // a 20-message window is blind to the real trigger. System events (Dario's
    // own status notes) are dropped: they never reach any turn's model context.
    const state = await this.room.state();
    const { events: rawAll } = await this.room.eventsFrom(0);
    const nonSystem = rawAll.filter((event) => event.author !== "system");
    if (nonSystem.length === 0) throw new Error("Nothing to review — this room's transcript is empty.");
    // Locate the turn where the classifier rerouted the model, and the flagged
    // agent whose floor bounds the replayed context. Both are event data — no
    // harness branch.
    const fallbackEvent = [...nonSystem].reverse().find((event) => "details" in event && event.details?.modelFallback);
    const flaggedAgentId = fallbackEvent && !("targets" in fallbackEvent) ? fallbackEvent.author : undefined;
    const floor = flaggedAgentId ? (state.contextFloors?.[flaggedAgentId] ?? 0) : 0;
    // From the floor forward = exactly what the agent re-reads each turn.
    const inContext = rawAll.slice(floor).filter((event) => event.author !== "system");
    // Cap to the review budget, biased to the tail (the reroute and freshest
    // re-scored content). Anything older that doesn't fit is reported loudly.
    let start = inContext.length;
    let budget = SANITIZE_REVIEW_CHAR_BUDGET;
    for (let i = inContext.length - 1; i >= 0; i--) {
      budget -= inContext[i].text.length + 48; // rough per-event header overhead
      if (budget < 0) break;
      start = i;
    }
    const events = inContext.slice(start);
    const droppedOlder = start; // in-context events too old to fit the budget
    if (droppedOlder > 0) {
      this.emit({
        type: "room-event",
        workspaceId: this.workspaceId,
        roomId: this.roomId,
        event: {
          id: newId("system_sanitize_scope"),
          timestamp: new Date().toISOString(),
          author: "system",
          text: `⚠ Dario reviewed the most recent ${events.length} of ${inContext.length} in-context messages (${droppedOlder} older ones exceeded the review budget). If the reroute persists, run the review again after applying — the tail shifts back and the older span comes into scope.`,
        },
      });
    }
    const context = flaggedAgentId ? await this.buildPersonaContext(flaggedAgentId) : undefined;
    const reply = await host.summonAndWait(
      this.roomId,
      SANITIZE_REVIEWER_ID,
      buildSanitizePrompt(events, {
        ...(fallbackEvent ? { fallbackEventId: fallbackEvent.id } : {}),
        ...(fallbackEvent && "details" in fallbackEvent && fallbackEvent.details?.modelFallback
          ? { fallbackTo: fallbackEvent.details.modelFallback.to, fallbackReason: fallbackEvent.details.modelFallback.reason }
          : {}),
        ...(context ? { context } : {}),
      }),
    );
    const proposal = parseSanitizeProposal(reply, events, {
      roomId: this.roomId,
      reviewer: SANITIZE_REVIEWER_ID,
      at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.sanitizeProposalPath, proposal);
    // Only report a proposal as pending in the snapshot when there is something
    // to apply. A parse-error / "found nothing" review (0 suggestions) can never
    // be applied, so reporting it would sit pending forever and re-pop the popup
    // on every reload; clearing it also supersedes any earlier pending proposal.
    // The file is still written above, so a manual re-open shows his raw notes.
    this.sanitizeStatus = proposal.suggestions.length > 0 ? { at: proposal.at, suggestions: proposal.suggestions.length } : undefined;
    await this.emitSnapshot();
    return proposal;
  }

  /** Assemble the flagged agent's real persona context (SOUL + active role) so
   * the reviewer sees what the classifier actually scored — the transcript
   * alone omits it. Read-only and length-capped; a trigger found here is
   * advisory (reported in `summary`), never an applyable transcript edit. */
  async buildPersonaContext(agentId: string): Promise<SanitizeContext | undefined> {
    const agent = this.workspace.agents[agentId];
    if (!agent) return undefined;
    const roleName = effectiveRoleName((await this.room.state()).activeRoles, agent);
    const role = roleName ? await resolveAgentRole(agent, roleName) : undefined;
    const soul = await readOptional(agent.soulPath);
    const parts = [soul.trim(), role ? `# Active Role: ${role.name}\n\n${role.prompt.trim()}` : ""].filter(Boolean);
    const text = parts.join("\n\n---\n\n").slice(0, PERSONA_CONTEXT_CAP);
    return text ? { agentId, text } : undefined;
  }

  /** Apply approved edits: rewrite the selected events in place (originals
   * preserved append-only in redactions.jsonl), then fresh sessions + capped
   * cursors so the next turn replays the sanitized window. Every quote is
   * re-validated against the live transcript — a stale or hallucinated quote
   * is skipped, never guessed at. */
  async sanitizeApply(edits: { eventId: string; quote: string; replacement: string }[]): Promise<{ applied: number; skipped: number }> {
    if (this.activeTask) throw new Error("A turn is running — wait for it to finish (or /cancel) before rewriting context.");
    if (edits.length === 0) throw new Error("No edits selected.");
    const { events } = await this.room.eventsFrom(0);
    const texts = new Map(events.map((event) => [event.id, event.text]));
    const next = new Map<string, string>();
    let skipped = 0;
    for (const edit of edits) {
      const current = next.get(edit.eventId) ?? texts.get(edit.eventId);
      if (current === undefined || !edit.quote || !current.includes(edit.quote)) {
        skipped++;
        continue;
      }
      next.set(edit.eventId, current.replace(edit.quote, edit.replacement));
    }
    if (next.size === 0) throw new Error("None of the selected edits matched the current transcript.");
    const edited = await this.room.redactEvents(next);

    const proposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    if (proposal?.at) {
      proposal.appliedAt = new Date().toISOString();
      await writeJsonAtomic(this.sanitizeProposalPath, proposal);
      this.sanitizeStatus = {
        at: proposal.at,
        suggestions: Array.isArray(proposal.suggestions) ? proposal.suggestions.length : 0,
        appliedAt: proposal.appliedAt,
      };
    }
    // Sanitize rewrites the triggering sentences in place — sessions holding the
    // original text must re-read the rewrite, or the redaction is cosmetic. But
    // the context itself must NOT change: "reset-keep-context" resets the affected
    // session yet replays the WHOLE conversation (never a shrunken window). The
    // cut is the first REWRITTEN index: any session that read past it saw the
    // original text and must re-seed.
    const editedCursors = await Promise.all([...next.keys()].map((id) => this.room.transcriptCursor(id)));
    const firstEdited = editedCursors.filter((cursor): cursor is number => cursor !== undefined).reduce((first, cursor) => Math.min(first, cursor - 1), Infinity);
    await this.resetAfterTruncation("reset-keep-context", Number.isFinite(firstEdited) ? firstEdited : 0);
    this.emit({
      type: "room-event",
      workspaceId: this.workspaceId,
      roomId: this.roomId,
      event: {
        id: newId("system_sanitize"),
        timestamp: new Date().toISOString(),
        author: "system",
        text: `✂ Rewrote ${edited.length} message${edited.length === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} skipped)` : ""} in place — context unchanged. Originals are preserved in redactions.jsonl; the next turn replays the full sanitized history.`,
      },
    });
    return { applied: edited.length, skipped };
  }

  /** The last saved proposal (popup re-open + the GET route). */
  async getSanitizeProposal(): Promise<SanitizeProposal | null> {
    const proposal = (await readJson(this.sanitizeProposalPath)) as SanitizeProposal | null;
    return proposal?.at ? proposal : null;
  }

  get sanitizeProposalPath(): string {
    return join(workspacePaths.roomDir(this.workspace.rootDir, this.roomId), "sanitize.json");
  }
}
export function installRoomSanitize(target: object): void { for (const name of Object.getOwnPropertyNames(RoomSanitizeMixin.prototype)) if (name !== "constructor") Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomSanitizeMixin.prototype, name)!); }
