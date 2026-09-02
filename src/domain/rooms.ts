// RoomHandle — the single writer for one room's transcript.jsonl + state.json,
// and the home of the durability protocol. Nothing else in the system writes
// these files.
//
// The WAL protocol ("no progress ever lost", made true by construction):
//   1. enqueue(): a message that can't run yet is persisted in state.queue —
//      a crash re-drains it on boot. No in-memory-only queues.
//   2. markPendingTurn(): before streaming, the reply's transcript event id is
//      RESERVED and persisted with the prompt. Partial replies flush in.
//   3. commitTurn(): append the agent event (carrying the reserved id AND its
//      runtime details) to the transcript, THEN one atomic state write that
//      clears pendingTurn and advances the author's cursor.
//   4. resume: a pendingTurn on a fresh read means interruption. If its
//      eventId already exists in the transcript, the crash landed between
//      append and state write — finish the state write (finishCommit). If not,
//      re-run the turn from partialReply. Idempotent either way.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BackgroundTask, ContextGatePending, EventDetails, MessageAttachment, MessageBlock, MonadConfig, PendingTurn, QueuedMessage, RoomEvent, RoomEventKind, RoomGoal, RoomState, SummonDelivery, ToolDetail } from "../core/types.js";
import { normalizePetBindings } from "./pets.js";
import { appendJsonl, appendJsonlBatchDurable, appendJsonlDurable, ensureDir, readJson, readJsonlFrom, readText, writeJsonAtomic, writeTextAtomic, writeTextIfMissing } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import { newId } from "../core/ids.js";
import { withSqliteImmediateLock } from "../core/sqlite.js";

/** The one transcript.jsonl serializer: one JSON line per event, trailing
 * newline, empty file for no events — byte-identical to what appendJsonl
 * produces, so a rewrite never changes the format. */
function serializeEvents(events: RoomEvent[]): string {
  return events.length ? events.map((event) => JSON.stringify(event)).join("\n") + "\n" : "";
}

export function newRoomEventId(): string {
  return newId("evt");
}

/** Rooms created by the "new room" UI get an opaque `chat-<slug>` id (see
 * newAutoRoomId in web/src/actions.js) and take their display title from their
 * first human message — so a room is never named by hand, the way a Claude Code
 * or Codex session titles itself from its opening prompt. This prefix is the
 * one signal that scopes that auto-title behaviour to freshly created rooms and
 * leaves existing / imported / hand-named rooms untouched. */
export const AUTO_ROOM_PREFIX = "chat-";

export function isAutoRoomId(roomId: string): boolean {
  return roomId.startsWith(AUTO_ROOM_PREFIX);
}

export const ROOM_TITLE_MAX = 48;

/** Normalize a user/model-proposed room title: one line, no wrapping quotes or
 * terminal sentence punctuation, capped for sidebar/tab use. Empty means
 * unusable. */
export function normalizeRoomTitle(text: string): string {
  let title = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  title = title
    .replace(/^```(?:\w+)?\s*/, "")
    .replace(/```$/, "")
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,]+$/g, "")
    .trim();
  if (!title) return "";
  return title.length > ROOM_TITLE_MAX ? `${title.slice(0, ROOM_TITLE_MAX - 1).trimEnd()}…` : title;
}

/** A one-line fallback display title distilled from a room's first message:
 * strip leading @mentions, collapse whitespace, cap. Empty (→ leave the room
 * untitled) when the message carries no usable text. */
export function deriveRoomTitle(text: string): string {
  return normalizeRoomTitle(text.replace(/^(?:@[A-Za-z0-9_-]+\s+)+/, ""));
}

// --- state normalization (accepts every v1 shape) ---------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unknownFields(value: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const unknown = { ...value };
  for (const key of known) delete unknown[key];
  return unknown;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0));
}

/** Plugin data is untrusted extension output: retain only bounded JSON values,
 * never executable/prototype-bearing objects. */
function pluginStateFrom(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 8) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 64)) {
    if (!key || key.length > 128) continue;
    if (raw === null || typeof raw === "boolean") out[key] = raw;
    else if (typeof raw === "string") out[key] = raw.slice(0, 4_000);
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (Array.isArray(raw)) {
      const safe = raw.slice(0, 128).map((entry) => pluginStateValue(entry, depth + 1)).filter((entry) => entry !== undefined);
      out[key] = safe;
    } else {
      const nested = pluginStateFrom(raw, depth + 1);
      if (nested) out[key] = nested;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function pluginStateValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 4_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 128).map((entry) => pluginStateValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  return pluginStateFrom(value, depth);
}

function cursorRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] >= 0)
      .map(([k, v]) => [k, Math.floor(v)]),
  );
}

/** Per-agent context accounting persisted in state.json. A malformed entry is
 * dropped (never bricks the room); an entry needs a finite usedTokens, and a
 * finite positive maxTokens is carried when present. */
function contextUsageFrom(value: unknown): Record<string, { usedTokens: number; maxTokens?: number }> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, { usedTokens: number; maxTokens?: number }> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.usedTokens !== "number" || !Number.isFinite(raw.usedTokens) || raw.usedTokens < 0) continue;
    const usedTokens = Math.floor(raw.usedTokens);
    const hasMax = typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0;
    out[id] = { usedTokens, ...(hasMax ? { maxTokens: Math.floor(raw.maxTokens as number) } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A held context-gate decision persisted in state.json. Needs an agent id and
 * message; malformed → absent (never blocks the room from opening). */
function backgroundTasksFrom(value: unknown): BackgroundTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: BackgroundTask[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.taskId !== "string" || !raw.taskId.trim()) continue;
    if (typeof raw.toolName !== "string" || !raw.toolName.trim()) continue;
    if (typeof raw.agentId !== "string" || !raw.agentId.trim()) continue;
    if (typeof raw.roomId !== "string" || !raw.roomId.trim()) continue;
    if (typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) continue;
    tasks.push({
      taskId: raw.taskId,
      toolName: raw.toolName,
      ...(typeof raw.command === "string" ? { command: raw.command } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.outputPath === "string" && raw.outputPath ? { outputPath: raw.outputPath } : {}),
      startedAt: raw.startedAt,
      agentId: raw.agentId,
      roomId: raw.roomId,
    });
  }
  const capped = tasks.slice(-20);
  return capped.length > 0 ? capped : undefined;
}

function contextGateFrom(value: unknown): ContextGatePending | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  if (typeof value.message !== "string") return undefined;
  const estTokens = typeof value.estTokens === "number" && value.estTokens >= 0 ? Math.floor(value.estTokens) : 0;
  const totalEvents = typeof value.totalEvents === "number" && value.totalEvents >= 0 ? Math.floor(value.totalEvents) : 0;
  const window = typeof value.window === "number" && value.window > 0 ? Math.floor(value.window) : undefined;
  const attachments = attachmentsFrom(value.attachments);
  const reason = value.reason === "session-lost" || value.reason === "new-agent" ? value.reason : undefined;
  const at = typeof value.at === "string" ? value.at : "";
  return {
    agentId: value.agentId,
    message: value.message,
    estTokens,
    totalEvents,
    ...(window ? { window } : {}),
    ...(attachments ? { attachments } : {}),
    ...(reason ? { reason } : {}),
    at,
  };
}

function toolDetail(value: unknown): ToolDetail | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.toolName !== "string") return undefined;
  const status = value.status === "running" || value.status === "error" ? value.status : "complete";
  return {
    id: value.id,
    toolName: value.toolName,
    status,
    ...(value.args !== undefined ? { args: value.args } : {}),
    ...(value.partialResult !== undefined ? { partialResult: value.partialResult } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
  };
}

function messageBlocks(value: unknown): MessageBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: MessageBlock[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (raw.kind === "tool" || raw.kind === "steer") {
      if (typeof raw.id === "string" && raw.id.length > 0) blocks.push({ kind: raw.kind, id: raw.id });
    } else if (raw.kind === "skill") {
      const skill = raw.skill;
      if (
        isRecord(skill) &&
        typeof skill.name === "string" && skill.name.length > 0 &&
        typeof skill.location === "string" && skill.location.length > 0 &&
        typeof skill.content === "string"
      ) {
        blocks.push({ kind: "skill", skill: { name: skill.name, location: skill.location, content: skill.content } });
      }
    } else if (raw.kind === "text" || raw.kind === "thinking") {
      // Drop empty text/thinking spans — they carry nothing to render and only
      // arise transiently while streaming.
      if (typeof raw.text === "string" && raw.text.length > 0) blocks.push({ kind: raw.kind, text: raw.text });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

export function eventDetailsFrom(value: unknown): EventDetails | undefined {
  if (!isRecord(value)) return undefined;
  const tools = Array.isArray(value.tools) ? value.tools.map(toolDetail).filter((t): t is NonNullable<typeof t> => Boolean(t)) : undefined;
  const blocks = messageBlocks(value.blocks);
  const summonResult = summonResultFrom(value.summonResult);
  const pluginDenial = pluginDenialFrom(value.pluginDenial);
  const details: EventDetails = {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(value.thinkingStarted === true ? { thinkingStarted: true } : {}),
    ...(typeof value.thinking === "string" && value.thinking.length > 0 ? { thinking: value.thinking } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(blocks ? { blocks } : {}),
    ...(summonResult ? { summonResult } : {}),
    ...(pluginDenial ? { pluginDenial } : {}),
  };
  return details.model || details.thinkingStarted || details.thinking || details.tools?.length || details.blocks?.length || details.summonResult || details.pluginDenial
    ? details
    : undefined;
}

/** ADV-021: a capability-broker rejection's durable provenance, reconstructed
 * from disk exactly like `summonResultFrom` just below — every field is
 * required (a partial denial record is not trustworthy audit evidence, so it
 * is dropped wholesale rather than reconstructed with holes). */
function pluginDenialFrom(value: unknown): EventDetails["pluginDenial"] {
  if (
    !isRecord(value)
    || typeof value.pluginId !== "string" || !value.pluginId
    || typeof value.capability !== "string" || !value.capability
    || typeof value.agentId !== "string" || !value.agentId
    || typeof value.reason !== "string" || !value.reason
  ) return undefined;
  return { pluginId: value.pluginId, capability: value.capability, agentId: value.agentId, reason: value.reason };
}

/** A summon worker's result provenance, reconstructed from disk (see
 * SummonResultMeta). Requires a childRoomId; failed defaults to false. */
function summonResultFrom(value: unknown): EventDetails["summonResult"] {
  if (!isRecord(value) || typeof value.childRoomId !== "string" || !value.childRoomId) return undefined;
  return { childRoomId: value.childRoomId, failed: value.failed === true };
}

function attachmentsFrom(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: MessageAttachment[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.path !== "string" || !raw.path.trim()) continue;
    attachments.push({
      ...unknownFields(raw, ["name", "mime", "size", "path"]),
      name: raw.name,
      mime: typeof raw.mime === "string" && raw.mime ? raw.mime : "application/octet-stream",
      size: typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? Math.floor(raw.size) : 0,
      path: raw.path,
    } as MessageAttachment);
  }
  return attachments.length > 0 ? attachments : undefined;
}

// A bad persisted block must never brick a room — it degrades to absent.
function monadFrom(value: unknown): MonadConfig | undefined {
  if (!isRecord(value) || typeof value.policy !== "string" || !value.policy.trim() || !Array.isArray(value.slots)) return undefined;
  const slots = [] as MonadConfig["slots"];
  for (const raw of value.slots) {
    if (!isRecord(raw) || typeof raw.agentId !== "string" || !raw.agentId.trim()) continue;
    slots.push({
      index: typeof raw.index === "number" && Number.isFinite(raw.index) ? Math.floor(raw.index) : slots.length,
      agentId: raw.agentId,
      ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label } : {}),
      ...(typeof raw.defaultRole === "string" && raw.defaultRole.trim() ? { defaultRole: raw.defaultRole } : {}),
    });
  }
  if (slots.length === 0) return undefined;
  const terminate =
    isRecord(value.terminate) && value.terminate.on === "verifier-accept" && typeof value.terminate.acceptToken === "string"
      ? { on: "verifier-accept" as const, acceptToken: value.terminate.acceptToken }
      : undefined;
  const rolePrompts = isRecord(value.rolePrompts)
    ? Object.fromEntries(Object.entries(value.rolePrompts).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined;
  return {
    policy: value.policy,
    ...(value.policyConfig !== undefined ? { policyConfig: value.policyConfig } : {}),
    slots,
    roles: Array.isArray(value.roles) ? value.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0) : [],
    maxTurns: typeof value.maxTurns === "number" && Number.isFinite(value.maxTurns) && value.maxTurns > 0 ? Math.floor(value.maxTurns) : 5,
    ...(typeof value.coordinatorAgentId === "string" && value.coordinatorAgentId.trim() ? { coordinatorAgentId: value.coordinatorAgentId } : {}),
    ...(terminate ? { terminate } : {}),
    ...(rolePrompts && Object.keys(rolePrompts).length > 0 ? { rolePrompts } : {}),
  };
}

function pendingTurnFrom(value: unknown): PendingTurn | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.prompt !== "string" || typeof value.agentId !== "string") return undefined;
  const targets = Array.isArray(value.targets) ? value.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
  if (targets.length === 0) return undefined;
  const attachments = attachmentsFrom(value.attachments);
  return {
    ...unknownFields(value, [
      "id", "eventId", "prompt", "attachments", "targets", "agentId", "partialReply", "channel", "goalStartedAt", "startedAt", "monad",
    ]),
    id: value.id,
    ...(typeof value.eventId === "string" && value.eventId ? { eventId: value.eventId } : {}),
    prompt: value.prompt,
    ...(attachments ? { attachments } : {}),
    targets,
    agentId: value.agentId,
    partialReply: typeof value.partialReply === "string" ? value.partialReply : "",
    ...(value.channel === "voice" ? { channel: "voice" as const } : {}),
    ...(typeof value.goalStartedAt === "string" && value.goalStartedAt.trim() ? { goalStartedAt: value.goalStartedAt } : {}),
    ...(value.monad === true ? { monad: true } : {}),
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
  } as PendingTurn;
}

function queueFrom(value: unknown): QueuedMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const queue: QueuedMessage[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.taskId !== "string" || typeof raw.text !== "string") continue;
    const targets = Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
    const attachments = attachmentsFrom(raw.attachments);
    queue.push({
      ...unknownFields(raw, [
        "taskId", "text", "targets", "channel", "attachments", "fromAgentDialogue", "goalStartedAt", "nativeCommand", "dogVerbTurn", "eventId", "recorded",
        "stallRetried", "authRetries", "notBefore", "queuedAt", "humanId", "humanLabel",
      ]),
      taskId: raw.taskId,
      text: raw.text,
      targets,
      ...(raw.channel === "voice" ? { channel: "voice" as const } : {}),
      ...(attachments ? { attachments } : {}),
      ...(raw.fromAgentDialogue === true ? { fromAgentDialogue: true } : {}),
      ...(typeof raw.goalStartedAt === "string" && raw.goalStartedAt.trim() ? { goalStartedAt: raw.goalStartedAt } : {}),
      ...(raw.nativeCommand === true ? { nativeCommand: true } : {}),
      ...(raw.dogVerbTurn === true ? { dogVerbTurn: true } : {}),
      // eventId/recorded are the queue→transcript crash-idempotency pair: drop
      // them and a restart re-appends a user event that is already on disk.
      ...(typeof raw.eventId === "string" && raw.eventId.trim() ? { eventId: raw.eventId } : {}),
      ...(raw.recorded === true ? { recorded: true } : {}),
      ...(raw.stallRetried === true ? { stallRetried: true } : {}),
      ...(typeof raw.authRetries === "number" ? { authRetries: raw.authRetries } : {}),
      ...(typeof raw.notBefore === "string" ? { notBefore: raw.notBefore } : {}),
      ...(typeof raw.humanId === "string" && raw.humanId.trim() ? { humanId: raw.humanId } : {}),
      ...(typeof raw.humanLabel === "string" && raw.humanLabel.trim() ? { humanLabel: raw.humanLabel } : {}),
      queuedAt: typeof raw.queuedAt === "string" ? raw.queuedAt : "",
    } as QueuedMessage);
  }
  return queue.length > 0 ? queue : undefined;
}

/** A room's pinned objective (see RoomGoal). A malformed record is dropped —
 * a broken goal must never wedge the room open/read path. */
function goalFrom(value: unknown): RoomGoal | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.objective !== "string" || !value.objective.trim()) return undefined;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  const status = value.status === "paused" || value.status === "done" ? value.status : "active";
  const budget = typeof value.tokenBudget === "number" && Number.isFinite(value.tokenBudget) && value.tokenBudget > 0 ? Math.floor(value.tokenBudget) : undefined;
  const now = new Date().toISOString();
  return {
    objective: value.objective,
    agentId: value.agentId,
    status,
    ...(budget ? { tokenBudget: budget } : {}),
    tokensUsed: typeof value.tokensUsed === "number" && Number.isFinite(value.tokensUsed) && value.tokensUsed > 0 ? Math.floor(value.tokensUsed) : 0,
    iterations: typeof value.iterations === "number" && Number.isFinite(value.iterations) && value.iterations > 0 ? Math.floor(value.iterations) : 0,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    ...(typeof value.stoppedReason === "string" && value.stoppedReason.trim() ? { stoppedReason: value.stoppedReason } : {}),
  };
}

/** A summon child room's pending result delivery (see SummonDelivery). A
 * malformed record is dropped — the room still opens; only the callback is
 * forfeited (and the coordinator logs recovery misses loudly). */
function summonDeliveryFrom(value: unknown): SummonDelivery | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  const deliver = value.deliver === "turn" ? "turn" : value.deliver === "note" ? "note" : undefined;
  if (!deliver) return undefined;
  // Fix #1 (resume-completion tracking): resumeStatus is only ever set by
  // SummonCoordinator.resume/recoverUndelivered (never a bare "running"
  // default like `status` above — an absent field means "no resume ever
  // tracked", which must stay distinguishable from "one is in flight").
  const resumeStatus = value.resumeStatus === "running" || value.resumeStatus === "delivered" ? value.resumeStatus : undefined;
  return {
    agentId: value.agentId,
    deliver,
    ...(typeof value.callerAgentId === "string" && value.callerAgentId.trim() ? { callerAgentId: value.callerAgentId } : {}),
    status: value.status === "delivered" ? "delivered" : "running",
    launchedAt: typeof value.launchedAt === "string" ? value.launchedAt : new Date().toISOString(),
    ...(resumeStatus ? { resumeStatus } : {}),
    ...(resumeStatus && typeof value.resumeStartedAt === "string" ? { resumeStartedAt: value.resumeStartedAt } : {}),
  };
}

export function normalizeRoomState(value: unknown): RoomState {
  if (!isRecord(value)) return { activeRoles: {}, agentCursors: {}, thinkingOverrides: {} };
  const runtimeDetails = isRecord(value.runtimeDetails)
    ? Object.fromEntries(
        Object.entries(value.runtimeDetails)
          .map(([k, v]) => [k, eventDetailsFrom(v)] as const)
          .filter((e): e is [string, EventDetails] => Boolean(e[1])),
      )
    : undefined;
  const monad = monadFrom(value.monad);
  const summon = summonDeliveryFrom(value.summon);
  const goal = goalFrom(value.goal);
  const pendingTurn = pendingTurnFrom(value.pendingTurn);
  const queue = queueFrom(value.queue);
  const contextUsage = contextUsageFrom(value.contextUsage);
  const backgroundTasks = backgroundTasksFrom(value.backgroundTasks);
  const contextGate = contextGateFrom(value.contextGate);
  const contextFloors = cursorRecord(value.contextFloors);
  const conversationEndedAgents = stringRecord(value.conversationEndedAgents);
  const petBindings = normalizePetBindings(value.petBindings);
  const pluginState = pluginStateFrom(value.pluginState);
  return {
    activeRoles: stringRecord(value.activeRoles),
    ...(petBindings ? { petBindings } : {}),
    ...(pluginState ? { pluginState: pluginState as Record<string, Record<string, unknown>> } : {}),
    thinkingOverrides: stringRecord(value.thinkingOverrides),
    ...(typeof value.thinkingLevel === "number" && Number.isFinite(value.thinkingLevel) && value.thinkingLevel > 0 && value.thinkingLevel <= 10
      ? { thinkingLevel: Math.floor(value.thinkingLevel) }
      : {}),
    agentCursors: cursorRecord(value.agentCursors),
    ...(Object.keys(contextFloors).length > 0 ? { contextFloors } : {}),
    ...(Object.keys(conversationEndedAgents).length > 0 ? { conversationEndedAgents } : {}),
    ...(runtimeDetails && Object.keys(runtimeDetails).length > 0 ? { runtimeDetails } : {}),
    ...(typeof value.parentRoomId === "string" && value.parentRoomId.trim() ? { parentRoomId: value.parentRoomId } : {}),
    ...(goal ? { goal } : {}),
    ...(summon ? { summon } : {}),
    ...(value.summonUntrusted === true ? { summonUntrusted: true } : {}),
    ...(typeof value.workDir === "string" && value.workDir.trim() ? { workDir: value.workDir } : {}),
    ...(typeof value.title === "string" && value.title.trim() ? { title: value.title } : {}),
    ...(value.titleSource === "auto" || value.titleSource === "model" || value.titleSource === "manual" ? { titleSource: value.titleSource } : {}),
    ...(value.favorite === true ? { favorite: true } : {}),
    ...(typeof value.imported === "string" && value.imported.trim() ? { imported: value.imported } : {}),
    ...(monad ? { monad } : {}),
    ...(pendingTurn ? { pendingTurn } : {}),
    ...(queue ? { queue } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(backgroundTasks ? { backgroundTasks } : {}),
    ...(contextGate ? { contextGate } : {}),
    ...(value.thanksDario === true ? { thanksDario: true } : {}),
    ...(typeof value.activeAgent === "string" && value.activeAgent.trim() ? { activeAgent: value.activeAgent } : {}),
    ...(value.agentDialogue === true ? { agentDialogue: true } : {}),
    ...(value.incognito === true ? { incognito: true } : {}),
    ...(stringArray(value.humans).length > 0 ? { humans: stringArray(value.humans) } : {}),
  };
}

// --- transcript parsing ------------------------------------------------------

/** AgentRoomEvent.renderCap round-trip (see services/plugins.ts
 * PluginRenderCap / domain/render-cap.ts). `note` is optional chrome text;
 * absent/garbage input (including a `note` of the wrong type) drops just
 * that field rather than the whole cap. */
function renderCapFrom(raw: unknown): { maxLines: number; note?: string } | undefined {
  if (!isRecord(raw) || typeof raw.maxLines !== "number" || !Number.isFinite(raw.maxLines)) return undefined;
  const note = typeof raw.note === "string" && raw.note ? raw.note : undefined;
  return { maxLines: raw.maxLines, ...(note ? { note } : {}) };
}

/** Back-compat for transcript lines committed before the whip-348 extraction
 * (AgentRoomEvent.dogRender: { maxLines, prefix }, domain/dog-mode.ts, now
 * deleted): maps the old shape onto the new one, DROPPING `prefix` — that
 * injected-text-into-the-agent's-own-message field is exactly the banned
 * placeholder pattern killed by whip 349, so it is never carried forward,
 * only `maxLines` survives. New writes never use this field name again (see
 * AgentRoomEvent.renderCap / RoomService#commitReply). */
function legacyDogRenderCapFrom(raw: unknown): { maxLines: number; note?: string } | undefined {
  if (!isRecord(raw) || typeof raw.maxLines !== "number" || !Number.isFinite(raw.maxLines)) return undefined;
  return { maxLines: raw.maxLines };
}

function roomEventFrom(raw: unknown, index: number): RoomEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.timestamp !== "string" || typeof raw.author !== "string" || typeof raw.text !== "string") return undefined;
  // Pre-id transcript lines get a deterministic line-based id.
  const id = typeof raw.id === "string" && raw.id ? raw.id : `legacy_${index}`;
  const kind: RoomEventKind | undefined =
    raw.kind === "compact-complete" || raw.kind === "turn-failed" || raw.kind === "plugin-reply" || raw.kind === "capability-denied" ? raw.kind : undefined;
  const base = {
    id,
    timestamp: raw.timestamp,
    text: raw.text,
    ...(typeof raw.channel === "string" && raw.channel ? { channel: raw.channel } : {}),
    ...(raw.redacted === true ? { redacted: true } : {}),
  };
  if (raw.author === "user") {
    const targets = Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === "string") : [];
    const attachments = attachmentsFrom(raw.attachments);
    const humanId = typeof raw.humanId === "string" && raw.humanId.trim() ? raw.humanId : undefined;
    const humanLabel = typeof raw.humanLabel === "string" && raw.humanLabel.trim() ? raw.humanLabel : undefined;
    return {
      ...base,
      author: "user",
      targets,
      ...(attachments ? { attachments } : {}),
      ...(humanId ? { humanId } : {}),
      ...(humanLabel ? { humanLabel } : {}),
    };
  }
  const details = eventDetailsFrom(raw.details);
  const renderCap = renderCapFrom(raw.renderCap) ?? legacyDogRenderCapFrom(raw.dogRender);
  return { ...base, author: raw.author, ...(kind ? { kind } : {}), ...(details ? { details } : {}), ...(renderCap ? { renderCap } : {}) };
}

async function readRoomState(path: string): Promise<unknown> {
  // State exists after RoomHandle.open. Parse failure is durability corruption,
  // not an empty document: rewriting it would destroy recoverable bytes.
  const state = JSON.parse(await readFile(path, "utf8")) as unknown;
  // Normalization remains lenient for callers handling arbitrary input, but a
  // persisted non-object or malformed privacy/trust bit is unsafe: never
  // silently weaken it.
  if (!isRecord(state)) throw new Error(`invalid persisted room state: ${path}`);
  for (const bit of ["summonUntrusted", "incognito"] as const) {
    if (bit in state && typeof state[bit] !== "boolean") throw new Error(`invalid persisted ${bit} bit: ${path}`);
  }
  return state;
}

function patchNormalizedState(raw: unknown, before: unknown, after: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return raw;
  if (!isRecord(before) || !isRecord(after)) return after;

  const patched: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  for (const key of Object.keys(before)) {
    if (!(key in after)) delete patched[key];
  }
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) patched[key] = value;
    else patched[key] = patchNormalizedState(patched[key], before[key], value);
  }
  return patched;
}

interface SharedRoomState {
  chain: Promise<unknown>;
  version: number;
}

const sharedRoomStates = new Map<string, SharedRoomState>();

function sharedRoomState(path: string): SharedRoomState {
  const key = resolve(path);
  let shared = sharedRoomStates.get(key);
  if (!shared) {
    shared = { chain: Promise.resolve(), version: 0 };
    sharedRoomStates.set(key, shared);
  }
  return shared;
}

// --- the handle --------------------------------------------------------------

export interface RoomPage {
  events: RoomEvent[];
  nextCursor: number;
}

/** Canonical tolerant transcript reader. Physical nonblank-line cursors stay
 * stable: malformed JSON and non-object lines consume a position but yield no
 * item, preserving durable replay ordering. */
export interface TranscriptRecord extends Record<string, unknown> {
  lineIndex: number;
}
export async function readTranscriptRecordsFrom(path: string, cursor = 0): Promise<{ items: TranscriptRecord[]; nextCursor: number }> {
  return readJsonlFrom<TranscriptRecord>(path, cursor, (raw, lineIndex) =>
    isRecord(raw) ? { ...raw, lineIndex } : undefined,
  );
}

export class RoomHandle {
  private stateCache: RoomState | undefined;
  private stateCacheVersion = -1;

  private constructor(
    readonly workspaceRoot: string,
    readonly roomId: string,
  ) {}

  /** `seed` is applied ONLY when this call is the one that creates the room's
   * state document, inside the create lock: first winner keeps its seed, later
   * openers (with or without a seed) never rewrite it. */
  static async open(workspaceRoot: string, roomId: string, seed?: { incognito?: boolean }): Promise<RoomHandle> {
    const handle = new RoomHandle(workspaceRoot, roomId);
    // Read-only fast path: an existing room needs no directory write and no
    // lock database. Opening a room to READ it must never create a sidecar
    // (read-only checkouts, snapshots, archived workspaces stay openable).
    if (existsSync(handle.statePath)) return handle;
    await ensureDir(workspacePaths.roomDir(workspaceRoot, roomId));
    const shared = sharedRoomState(handle.statePath);
    const initialize = shared.chain.then(async () => {
      await withSqliteImmediateLock(handle.stateLockPath, async () => {
        if (existsSync(handle.statePath)) return;
        await writeJsonAtomic(handle.statePath, normalizeRoomState(seed?.incognito ? { incognito: true } : undefined));
        shared.version++;
      });
    });
    shared.chain = initialize.catch(() => {});
    await initialize;
    return handle;
  }

  get transcriptPath(): string {
    return workspacePaths.transcript(this.workspaceRoot, this.roomId);
  }

  get statePath(): string {
    return workspacePaths.roomState(this.workspaceRoot, this.roomId);
  }

  /** ONE lock per room, shared by state.json and transcript.jsonl writers.
   * Cross-process mutual exclusion of the two files must be the SAME lock or
   * a transcript rewrite could interleave with a state commit; a second lock
   * would also open a lock-ordering deadlock. Never acquired nested. */
  private get stateLockPath(): string {
    return `${this.statePath}.lock.sqlite`;
  }

  /** Run `work` under the room lock, serialized in-process on the same chain
   * as state writes. `work` MUST NOT call any public method that acquires the
   * lock again (updateState/appendEvent/...): the chain makes that a deadlock,
   * by design — nesting is a bug, not a slow path. */
  private async withRoomLock<T>(work: () => Promise<T>): Promise<T> {
    const shared = sharedRoomState(this.statePath);
    const run = (): Promise<T> => withSqliteImmediateLock(this.stateLockPath, work);
    const next = shared.chain.then(run, run);
    shared.chain = next.catch(() => {});
    return next;
  }

  async state(): Promise<RoomState> {
    // A peer process has no access to sharedRoomStates/version. Read the
    // atomically-renamed document on every public observation instead.
    const shared = sharedRoomState(this.statePath);
    this.stateCache = normalizeRoomState(await readRoomState(this.statePath));
    this.stateCacheVersion = shared.version;
    return this.stateCache;
  }

  /** Apply one typed delta over the latest raw document. Every handle for this
   * room shares the same chain; unknown future fields survive unchanged. */
  async updateState(mutate: (state: RoomState) => void): Promise<RoomState> {
    return this.withRoomLock(() => this.updateStateLocked(mutate));
  }

  /** The state delta itself, WITHOUT acquiring the room lock — for composite
   * operations that already hold it (clearRoom). Lock spans read → typed patch
   * → atomic rename. It is deliberately a sidecar lock: state.json remains the
   * source of truth and preserves unknown fields and its established bytes for
   * no-op mutations. */
  private async updateStateLocked(mutate: (state: RoomState) => void): Promise<RoomState> {
    const shared = sharedRoomState(this.statePath);
    const raw = await readRoomState(this.statePath);
    const before = normalizeRoomState(raw);
    const state = structuredClone(before);
    mutate(state);
    if (!isDeepStrictEqual(before, state)) {
      await writeJsonAtomic(this.statePath, patchNormalizedState(raw, before, state));
      shared.version++;
    }
    this.stateCache = state;
    this.stateCacheVersion = shared.version;
    return state;
  }

  /** Exact state replacement for an import already holding the room lock. */
  private async replaceStateLocked(state: RoomState): Promise<void> {
    const shared = sharedRoomState(this.statePath);
    await writeJsonAtomic(this.statePath, state);
    shared.version++;
    this.stateCache = state;
    this.stateCacheVersion = shared.version;
  }

  /** Drop the in-memory cache retained for an update result. Public state()
   * already reads disk so foreign-process writers are observable. */
  invalidate(): void {
    this.stateCache = undefined;
  }

  // --- transcript ------------------------------------------------------------

  async appendEvent(event: RoomEvent): Promise<void> {
    await this.withRoomLock(() => appendJsonlDurable(this.transcriptPath, event));
  }
  /** Append an agent's visible goodbye and durably suppress its automatic
   * follow-ups as one room-lock transaction. */
  async endConversation(agentId: string, event: RoomEvent): Promise<void> {
    await this.withRoomLock(async () => {
      await appendJsonlDurable(this.transcriptPath, event);
      await this.updateStateLocked((state) => {
        state.conversationEndedAgents = { ...(state.conversationEndedAgents ?? {}), [agentId]: event.timestamp };
      });
    });
  }

  /** `id` pre-assigns the event id — the queue→transcript hand-off reserves it
   * durably on the QueuedMessage first, so a crash-replayed append is
   * idempotent (see QueuedMessage.eventId). */
  async addUserMessage(
    text: string,
    targets: string[],
    channel?: string,
    attachments?: MessageAttachment[],
    id?: string,
    human?: { id: string; label: string }
  ): Promise<RoomEvent> {
    const event: RoomEvent = {
      id: id ?? newRoomEventId(),
      timestamp: new Date().toISOString(),
      author: "user",
      targets,
      text,
      ...(channel ? { channel } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(human ? { humanId: human.id, humanLabel: human.label } : {}),
    };
    await this.appendEvent(event);
    return event;
  }

  /** /clear as ONE critical section: archive → wipe transcript → reset the
   * state that describes it (cursors, legacy runtimeDetails), under a single
   * acquisition of the room lock. Split across two acquisitions, a concurrent
   * process can commit a turn in between and leave cursors pointing past a
   * transcript that no longer has those lines (silent amnesia / replay).
   *
   * pending/queue are deliberately NOT touched: a queued message is owed work
   * that survives history wipes, and a pendingTurn is another writer's live
   * WAL record — clearing it here would strand or double-run that turn. /clear
   * is therefore safe on a BUSY room, not only an idle one; the turn in flight
   * commits its reply onto the fresh transcript. */
  async clearRoom(): Promise<void> {
    await this.withRoomLock(async () => {
      const { events } = await this.readEventsLocked();
      await this.archiveLocked(workspacePaths.roomRewound(this.workspaceRoot, this.roomId), events);
      await writeTextAtomic(this.transcriptPath, "");
      await this.updateStateLocked((state) => {
        state.agentCursors = {};
        delete state.runtimeDetails;
      });
    });
  }

  /** Replace the whole transcript with `events` (backs explicit import
   * --force). The ONE history-rewrite entry point besides clear/rewind/redact:
   * importers must come through here instead of writing transcript.jsonl
   * behind the room lock's back.
   *
   * Conservative by construction: whatever was there — including lines a
   * concurrent process appended while the import was reading its export — is
   * archived to rewound.jsonl and fsynced BEFORE the replacement publishes. A
   * --force import destroys no history, it only stops replaying it. */
  async replaceTranscript(events: RoomEvent[]): Promise<void> {
    await this.replaceImportedRoom(events);
  }

  /** Import transcript + selected state as one room-lock transaction. A
   * non-force caller tests occupancy INSIDE that lock; false means no bytes
   * changed. No observer can append against old transcript then patch new
   * state, or see their state delta paired with the old transcript. */
  async replaceImportedRoom(events: RoomEvent[], state?: RoomState, options?: { refuseIfNonempty?: boolean }): Promise<boolean> {
    return this.withRoomLock(async () => {
      // Occupancy is a byte-level question, checked inside the lock. A legacy
      // or future transcript may not parse under this daemon, but non-force
      // import must still refuse it rather than trying to normalize it.
      const raw = (await readText(this.transcriptPath)) ?? "";
      if (options?.refuseIfNonempty && raw.trim()) return false;
      const { events: existing } = await this.readEventsLocked();
      await this.archiveLocked(workspacePaths.roomRewound(this.workspaceRoot, this.roomId), existing);
      await writeTextAtomic(this.transcriptPath, serializeEvents(events));
      if (state) await this.replaceStateLocked(state);
      return true;
    });
  }

  /** The transcript's bytes, read under the room lock (backs /fork's source
   * side): an unlocked read can catch a full rewrite mid-publish or an append
   * mid-line. Returns "" for a room that never wrote one.
   *
   * Lock order: the snapshot is taken and the lock RELEASED before the target
   * room's handle is touched. Source and target locks are never held at the
   * same time, so two rooms forking into each other cannot deadlock. */
  async snapshotTranscript(): Promise<string> {
    return (await this.snapshotRoom()).transcript;
  }

  /** Fork source snapshot: transcript and selected state share ONE source
   * lock acquisition. Target reservation deliberately occurs afterwards;
   * source/target locks are never held together. */
  async snapshotRoom(): Promise<{ transcript: string; state: RoomState }> {
    return this.withRoomLock(async () => ({
      transcript: (await readText(this.transcriptPath)) ?? "",
      state: await readRoomState(this.statePath).then(normalizeRoomState),
    }));
  }

  /** Seed this (new) room's transcript with `text`, exclusively: `wx`, so the
   * fork target is created by exactly one writer and an existing room's
   * history can never be clobbered by a fork/import landing on its id.
   * Returns whether this call created it. */
  async seedTranscript(text: string): Promise<boolean> {
    return this.withRoomLock(() => writeTextIfMissing(this.transcriptPath, text));
  }

  /** Rewind: drop the last `userTurns` user messages and every event after
   * them (backs /rewind — the room-level checkpoint that works for every
   * harness). Returns the dropped events, or undefined when the room has
   * fewer user messages. Cursors/sessions are the caller's to reset; the
   * per-room recall index rebuilds itself on shrink. */
  async rewindTranscript(userTurns: number): Promise<RoomEvent[] | undefined> {
    return this.withRoomLock(async () => {
    const { events } = await this.readEventsLocked();
    let cut = -1;
    let seen = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].author !== "user") continue;
      seen++;
      if (seen >= userTurns) {
        cut = i;
        break;
      }
    }
    if (cut < 0) return undefined;
    return this.truncateAt(events, cut);
    });
  }

  /** Rewind to a specific event: drop it and everything after (backs message
   * edit and reply retry — the fork-from-here primitive). Returns the dropped
   * events, or undefined when the id is not in the transcript. */
  async rewindToEvent(eventId: string): Promise<RoomEvent[] | undefined> {
    return this.withRoomLock(async () => {
      const { events } = await this.readEventsLocked();
      const cut = events.findIndex((event) => event.id === eventId);
      if (cut < 0) return undefined;
      return this.truncateAt(events, cut);
    });
  }

  /** All transcript truncation funnels through here. Dropped events are
   * preserved append-only in rewound.jsonl beside the transcript — a rewind
   * discards them from the conversation, never from disk. Caller holds the
   * room lock: read → archive → publish is one critical section, so a
   * concurrent append can neither be silently dropped nor half-written. */
  private async truncateAt(events: RoomEvent[], cut: number): Promise<RoomEvent[]> {
    const kept = events.slice(0, cut);
    const dropped = events.slice(cut);
    await this.archiveLocked(workspacePaths.roomRewound(this.workspaceRoot, this.roomId), dropped);
    // Atomic: the kept head has no other copy — a torn rewrite would be
    // permanent loss of committed history.
    await writeTextAtomic(this.transcriptPath, serializeEvents(kept));
    return dropped;
  }

  /** Rewrite the text of specific events in place (backs the thanks-dario
   * context sanitize). Each edited event's ORIGINAL line is appended to
   * redactions.jsonl beside the transcript BEFORE the rewrite — a redaction
   * changes what replays into prompts, never what exists on disk. The line
   * count is unchanged, so every existing cursor stays valid. Returns the
   * ids actually edited (unknown ids and no-op texts are ignored). */
  async redactEvents(edits: Map<string, string>): Promise<string[]> {
    return this.withRoomLock(async () => {
    const { events } = await this.readEventsLocked();
    const edited = new Set<string>();
    const redactionsPath = workspacePaths.roomRedactions(this.workspaceRoot, this.roomId);
    const originals: RoomEvent[] = [];
    for (const event of events) {
      const text = edits.get(event.id);
      if (text === undefined || text === event.text) continue;
      originals.push(event);
      edited.add(event.id);
    }
    await this.archiveLocked(redactionsPath, originals);
    if (edited.size === 0) return [];
    const next = events.map((event) => (edited.has(event.id) ? { ...event, text: edits.get(event.id)!, redacted: true } : event));
    // Atomic: every unedited event exists only on this line — a torn rewrite
    // would destroy committed history far beyond the redaction.
    await writeTextAtomic(this.transcriptPath, serializeEvents(next));
    return [...edited];
    });
  }

  /** Transcript read for a mutation already holding the room lock. Identical
   * parse to the public eventsFrom (same format, same legacy-details merge)
   * and lock-free itself — state() only reads the atomically-renamed
   * document, so no nested acquisition happens here. */
  private async readEventsLocked(): Promise<RoomPage> {
    const raw = await readText(this.transcriptPath);
    if (raw) {
      if (!raw.endsWith("\n")) throw new Error("Transcript rewrite refused: noncanonical raw tail");
      let index = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error("Transcript rewrite refused: malformed raw line"); }
        const event = roomEventFrom(value, index++);
        // Compare parsed structures, not JSON text: key order is irrelevant,
        // while unknown or normalized-away nested metadata would be destroyed
        // by a rewrite and therefore fails closed.
        if (!event || line.endsWith("\r") || !isDeepStrictEqual(value, event))
          throw new Error("Transcript rewrite refused: noncanonical raw line");
      }
    }
    return this.eventsFrom(0);
  }

  /** Physical raw-line cursor: all durable cursors count JSONL lines, not
   * parsed events. Invalid lines remain visible to cursor arithmetic. */
  async transcriptCursor(eventId?: string): Promise<number | undefined> {
    const page = await readJsonlFrom<number>(this.transcriptPath, 0, (raw, lineIndex) =>
      eventId === undefined || (raw && typeof raw === "object" && (raw as { id?: unknown }).id === eventId)
        ? lineIndex + 1 : undefined,
    );
    return eventId === undefined ? page.nextCursor : page.items.at(-1);
  }

  /** Archive events that a rewrite is about to remove from the live file, and
   * make them durable BEFORE the rewrite publishes — the archive is their only
   * remaining copy, so "written but not yet on disk" is exactly the window in
   * which a power cut turns a rewind into deletion.
   *
   * Retry note: a crash midway leaves a PARTIAL archive, and re-running the
   * operation appends those events a second time. Duplicate archive lines are
   * accepted deliberately — the invariant this file must carry is "every event
   * that ever existed is in live ∪ archive", which duplication cannot break,
   * while dedup keying (an operation id per rewrite) would add a second
   * durable record to keep consistent for a cosmetic gain. NO production
   * reader of rewound/redactions exists today: whoever writes the first one
   * MUST dedup by event id (repeated id = one event), or a retried rewrite
   * shows history twice. */
  private async archiveLocked(path: string, events: RoomEvent[]): Promise<void> {
    // ONE write + ONE fsync for the whole batch: this runs inside the room
    // lock, so a per-event sync made clear/rewind/import hold time linear in
    // history and eventually collide with the lock timeout.
    await appendJsonlBatchDurable(path, events);
  }

  // --- durable compaction summaries -------------------------------------------
  // Keyed by agentId → { floorIdx, summary }: the harness's own summary of the
  // history below the agent's context floor. On a session-loss replay the daemon
  // feeds [summary + tail after floorIdx] instead of raw-from-0 or a thin tail,
  // so an explicit /compact survives every reset. Valid only while floorIdx still
  // equals the live floor (a moved floor auto-invalidates it). compaction.json
  // lives beside the transcript — derived state, never part of the WAL.

  private compactionPath(): string {
    return workspacePaths.roomCompaction(this.workspaceRoot, this.roomId);
  }

  private async readCompactionMap(): Promise<Record<string, { floorIdx: number; summary: string }>> {
    return ((await readJson(this.compactionPath())) as Record<string, { floorIdx: number; summary: string }> | undefined) ?? {};
  }

  /** The stored summary for an agent, or undefined if none. Callers must still
   * check floorIdx against the live floor before trusting it. */
  async readCompaction(agentId: string): Promise<{ floorIdx: number; summary: string } | undefined> {
    const entry = (await this.readCompactionMap())[agentId];
    return entry && typeof entry.summary === "string" && typeof entry.floorIdx === "number" ? entry : undefined;
  }

  async writeCompaction(agentId: string, floorIdx: number, summary: string): Promise<void> {
    const all = await this.readCompactionMap();
    all[agentId] = { floorIdx, summary };
    await writeJsonAtomic(this.compactionPath(), all);
  }

  async clearCompaction(agentId: string): Promise<void> {
    const all = await this.readCompactionMap();
    if (!(agentId in all)) return;
    delete all[agentId];
    await writeJsonAtomic(this.compactionPath(), all);
  }

  async eventsFrom(cursor: number): Promise<RoomPage> {
    const records = await readTranscriptRecordsFrom(this.transcriptPath, cursor);
    const page = {
      items: records.items.map((record) => roomEventFrom(record, record.lineIndex)).filter((event): event is RoomEvent => event !== undefined),
      nextCursor: records.nextCursor,
    };
    // Merge legacy v1 side-table details onto agent events that lack them.
    const state = await this.state();
    const legacy = state.runtimeDetails;
    const events = legacy
      ? page.items.map((event) => {
          // The union is not discriminated by author (agent authors are plain
          // strings), so narrow via the property instead.
          if (event.author === "user" || ("details" in event && event.details)) return event;
          const details = legacy[event.id];
          return details ? { ...event, details } : event;
        })
      : page.items;
    return { events, nextCursor: page.nextCursor };
  }

  async recentEvents(limit: number): Promise<RoomEvent[]> {
    const { events } = await this.eventsFrom(0);
    return events.slice(-limit);
  }

  async hasEvent(eventId: string): Promise<boolean> {
    return this.hasEventLocked(eventId);
  }

  /** hasEvent for callers already holding the room lock (never re-acquires).
   * This is intentionally LENIENT: appending a new reserved event must remain
   * possible after legacy/pre-id or damaged lines. Strict validation belongs
   * only to operations that rewrite existing bytes. */
  private async hasEventLocked(eventId: string): Promise<boolean> {
    const page = await readJsonlFrom<boolean>(this.transcriptPath, 0, (raw) =>
      raw && typeof raw === "object" && (raw as { id?: unknown }).id === eventId ? true : undefined,
    );
    return page.items.length > 0;
  }

  // --- durable queue -----------------------------------------------------------

  async enqueue(message: QueuedMessage): Promise<void> {
    await this.updateState((state) => {
      state.queue = [...(state.queue ?? []), message];
    });
  }

  /** The head of the durable queue WITHOUT removing it. The entry stays queued
   * until a successor durable record exists (the appended user event / the
   * pendingTurn marker / a command's persisted reply) and the caller then
   * consumes it via spliceQueued or markPendingTurn's consume option — the
   * two-phase hand-off that makes a crash re-drain instead of losing the
   * message (the old dequeue-first held it in memory only). */
  async peekQueue(): Promise<QueuedMessage | undefined> {
    return (await this.state()).queue?.[0];
  }

  /** Durably reserve the transcript event id a queued message will commit
   * under, BEFORE the append — so a crash between the two replays the append
   * idempotently (same id, hasEvent-guarded). No-op if the entry is gone. */
  async assignQueuedEventId(taskId: string, eventId: string): Promise<void> {
    await this.updateState((state) => {
      const entry = state.queue?.find((candidate) => candidate.taskId === taskId);
      if (entry) entry.eventId = eventId;
    });
  }

  /** Remove one entry by task id — idempotent (a multi-target turn consumes it
   * once per markPendingTurn; only the first splice finds it). */
  async spliceQueued(taskId: string): Promise<void> {
    await this.updateState((state) => {
      if (!state.queue) return;
      const next = state.queue.filter((candidate) => candidate.taskId !== taskId);
      if (next.length > 0) state.queue = next;
      else delete state.queue;
    });
  }

  async clearQueue(): Promise<QueuedMessage[]> {
    let dropped: QueuedMessage[] = [];
    await this.updateState((state) => {
      dropped = state.queue ?? [];
      delete state.queue;
    });
    return dropped;
  }

  // --- WAL turn protocol ---------------------------------------------------------

  /** `consumeQueuedTaskId` removes that queue entry in the SAME atomic state
   * write that creates the marker — the queued message's durable custody moves
   * from queue to WAL with no window where it exists in neither. */
  async markPendingTurn(turn: PendingTurn, options?: { consumeQueuedTaskId?: string }): Promise<void> {
    await this.updateState((state) => {
      state.pendingTurn = turn;
      if (options?.consumeQueuedTaskId && state.queue) {
        const next = state.queue.filter((candidate) => candidate.taskId !== options.consumeQueuedTaskId);
        if (next.length > 0) state.queue = next;
        else delete state.queue;
      }
    });
  }

  async flushPartialReply(partialReply: string): Promise<void> {
    await this.updateState((state) => {
      if (state.pendingTurn) state.pendingTurn.partialReply = partialReply;
    });
  }

  async clearPendingTurn(): Promise<void> {
    await this.updateState((state) => {
      delete state.pendingTurn;
    });
  }

  /**
   * Commit a finished turn: append the reply event (reserved id + details on
   * the event), then ONE atomic state write that clears the pending marker
   * (or swaps in `nextPending` — the multi-target hand-off, so the remaining
   * targets' owed turns never live in memory only) and advances the author's
   * cursor.
   *
   * The cursor is computed HERE, from the reply's own line: everything up to
   * and including the reply is in the author's harness session — including
   * events that landed DURING the turn (inline steers, summon notes: all
   * delivered into the live turn) — while anything appended after the reply
   * was never seen live and stays unswept. The caller-supplied pre-stream
   * `count + 1` this replaces undercounted whenever a steer landed mid-turn,
   * replaying the agent's own reply (and any later steer) as fresh context.
   */
  async commitTurn(event: RoomEvent, nextPending?: PendingTurn): Promise<void> {
    // has → append is ONE critical section: two processes replaying the same
    // reserved event id must produce exactly one line (an unlocked check-then-
    // append duplicates it). The cursor scan stays inside too, so the offset
    // matches the file this turn actually committed against.
    await this.withRoomLock(async () => {
      // fsynced here, BEFORE the state write below clears pendingTurn and
      // advances the cursor: the WAL's ordering is only real if the append is
      // durable first — otherwise a power cut can leave a state that says
      // "committed" over a transcript that lost the reply.
      if (!(await this.hasEventLocked(event.id))) await appendJsonlDurable(this.transcriptPath, event);
      const page = await readJsonlFrom<number>(this.transcriptPath, 0, (raw, lineIndex) =>
        raw && typeof raw === "object" && (raw as { id?: unknown }).id === event.id ? lineIndex : undefined,
      );
      const cursorAfter = page.items.length > 0 ? page.items[page.items.length - 1] + 1 : page.nextCursor;
      // Keep append→cursor scan→ack contiguous. A crash after append still
      // retains pendingTurn and resumeMode performs finish-commit.
      await this.updateStateLocked((state) => {
        if (nextPending) state.pendingTurn = nextPending;
        else delete state.pendingTurn;
        state.agentCursors[event.author] = cursorAfter;
      });
    });
  }

  /**
   * Resume decision for a pendingTurn found on boot:
   * - "finish-commit": the reply already reached the transcript; only the
   *   state write is missing. Caller finishes with commitTurn (idempotent).
   * - "rerun": stream the turn again from pendingTurn.partialReply.
   */
  async resumeMode(pending: PendingTurn): Promise<"finish-commit" | "rerun"> {
    if (pending.eventId && (await this.hasEvent(pending.eventId))) return "finish-commit";
    return "rerun";
  }
}
