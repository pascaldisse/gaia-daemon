// Prompt assembly — the one place a turn's words are put together, shared by
// every harness. Layering (identical for all three adapters):
//   system prompt = soul → project intent → AGENTS.md chain → active role
//   turn prompt   = room header → voice hints → memory (only when changed)
//                   → new room events → newest message
// CLI harnesses additionally inline role-skill text + a `gaia` CLI pointer
// (buildInlineSystemPrompt) because they cannot load Pi-style skill files.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { globalPaths } from "../core/paths.js";
import type { AgentDef, ContextFile, MessageAttachment, RoomEvent, ToolDetail, Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import type { ResolvedRole } from "../domain/roles.js";
import { discoverContextFiles } from "../domain/workspace.js";
import { agentSkillNames, loadSkillText } from "../domain/skills.js";
import type { ContextDietPolicy } from "../domain/context-diet.js";
import type { AgentInput } from "./spec.js";
import { harnessIdFor, nativeCommandsFor } from "./spec.js";
import { GAIA_TOOLS, gaiaToolIds, type GaiaToolSpec, type PointerContext } from "./tools.js";

export interface SystemPromptInput {
  agent: AgentDef;
  soulText: string;
  role?: ResolvedRole;
  intentText?: string;
  contextFiles: ContextFile[];
  /** Concatenated verbatim text of ~/.gaia/protocols/*.md (buildBaseSystemPrompt
   * reads it). ""/undefined = no `# Protocols` section at all (zero change). */
  protocolsText?: string;
  /** Room-scoped GAIA-THINK level 0-10. Only affects the trailing line of the
   * Protocols section, and only when protocolsText is present. Unset = 0. */
  thinkingLevel?: number;
}

/** Cache key for the per-session system prompt: role name plus the room's
 * protocol thinking level, so changing the level invalidates the cached prompt
 * on the next turn (the level rides IN the system prompt). */
export function promptCacheKey(roleName: string | undefined, thinkingLevel?: number): string {
  return `${roleName ?? ""}#t${thinkingLevel ?? 0}`;
}

/** The `# Protocols` section (or "" when no protocol text is loaded). When
 * loaded, a trailing line always states the room's GAIA-THINK level: level 0
 * (or unset) disables thought blocks, level N announces `N/10`. */
export function buildProtocolsSection(protocolsText?: string, thinkingLevel?: number): string {
  const body = protocolsText?.trim();
  if (!body) return "";
  const level = thinkingLevel ?? 0;
  const levelLine = level > 0 ? `Current thinking level: ${level}/10` : "Thinking disabled — do not emit <gaia:think> blocks.";
  return `# Protocols\n\n${body}\n\n${levelLine}`;
}

/** Read every *.md in the protocols dir (sorted by filename) and join their
 * verbatim contents with blank lines. Missing dir / no *.md → "". */
export async function readProtocolsText(dir: string = globalPaths.protocolsDir()): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md")).sort();
  } catch {
    return "";
  }
  const parts = await Promise.all(names.map((name) => readOptional(join(dir, name))));
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export interface TurnPromptInput {
  roomId: string;
  agentId: string;
  message: string;
  events: RoomEvent[];
  // Persistent memory content, included only when it changed since the last
  // turn so memory writes do not force a session reload mid-conversation.
  memory?: string;
  /** Auto-retrieved memories for THIS turn; already fenced by the service. */
  recall?: string;
  /** Context returned by room-local command plugins. */
  pluginContext?: string;
  channel?: "text" | "voice";
  /** Files attached to the newest message (pasted into the composer). */
  attachments?: MessageAttachment[];
  /** Where this agent's child process actually runs (RunnerHost's cwd) and
   * the workspace root it was cloned from. When they differ, the turn
   * prompt tells the agent it is in an isolated per-room worktree. Optional
   * so callers that have no notion of a worktree (e.g. tests) need not set
   * it — no line is emitted in that case either. */
  workDir?: string;
  rootDir?: string;
  /** Settings ▸ General ▸ "Your name" — see renderRoomTranscript. */
  userName?: string;
  /** Agent-declared law line (agent.json `turnLaw`) appended as the very last
   * tokens of the composed turn prompt so it is always freshest. */
  turnLaw?: string;
  /** Context-diet policy (09-MEMORY-CONTEXT, /diet room command). Absent or
   * `preset:false` renders IDENTICALLY to no diet at all — default OFF, IRON. */
  dietPolicy?: ContextDietPolicy;
}

/** Render-time diet context for renderRoomTranscript: which agent "owns" a
 * room event's tool activity (own vs. another agent's), used only when
 * `policy.preset` is true. */
export interface DietRenderContext {
  policy: ContextDietPolicy;
  currentAgentId: string;
}

// Turn-level overlay (not the system prompt) so entering/leaving a call never
// forces a session reload.
const VOICE_MODE_INSTRUCTIONS = [
  "Voice mode: you are on a live voice call with the user. Your reply will be spoken aloud by a text-to-speech engine.",
  "The user's words were transcribed by speech-to-text and may contain transcription mistakes; if something seems off, guess the likely intent rather than asking.",
  "Keep replies short and conversational - a few spoken sentences unless asked for more.",
  "Plain prose only: no markdown, no headings, no bullet points, no code blocks, no emojis. Everything you write is pronounced literally.",
  "Write numbers, abbreviations and symbols the way they should be spoken.",
  "You can still use your tools; the user only hears your final text.",
].join("\n");

/** Render an event timestamp (stored as ISO UTC) in the host's local
 * timezone for prompt injection. Timezone is auto-detected via Intl; pass
 * `timeZone` to override (never hardcoded). Falls back to the raw string for
 * unparseable input. */
export function formatEventTimestamp(timestamp: string, timeZone?: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return date.toLocaleString("sv-SE", { timeZone: tz, timeZoneName: "short" });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One breadcrumb line per attached file: name, mime, size, and the on-disk
 * path — the file stays readable there, so any agent can open it with its
 * tools even on a replayed/rewound transcript. Uniform for every harness;
 * harnesses with a native image channel attach the bytes IN ADDITION. */
export function renderAttachmentLines(attachments: MessageAttachment[]): string {
  return attachments.map((file) => `[attached file: ${file.name} (${file.mime}, ${humanSize(file.size)}) at ${file.path}]`).join("\n");
}

/** Best-effort readable text for a tool's raw JSON result — the same
 * `{content:[{type:"text",text}]}` shape every gaia tool returns; anything
 * else is stringified rather than dropped (never silently discard a result). */
function toolResultPreviewText(result: unknown): string {
  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    const blocks = (result as { content: unknown[] }).content;
    const text = blocks
      .filter((block): block is { type: "text"; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text) return text;
  }
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** One tool call's full, uncollapsed preview: call signature line + result
 * text (multi-line result stays multi-line — boundedActivityPreview below is
 * what trims/collapses it, never this). */
function toolDetailPreview(tool: ToolDetail): string {
  const args = tool.args !== undefined ? (() => { try { return JSON.stringify(tool.args); } catch { return String(tool.args); } })() : "";
  const header = `${tool.toolName}(${args})`;
  const resultText = tool.result !== undefined ? toolResultPreviewText(tool.result) : tool.status === "running" ? "(running)" : "";
  return resultText ? `${header}\n${resultText}` : header;
}

/** Own-vs-other diet projection (09-MEMORY-CONTEXT "Diet projection", ported
 * from gaia-daemon-v2 pi-agent-runtime.ts boundedActivityPreview): own tool
 * calls stay full while recent (within `fullTurnWindow` room events) or when
 * `keepAllToolCalls` is set; own tool calls OLDER than the window collapse to
 * a one-line stub carrying the room event id + tool id so a `tool_result_fetch`
 * gaia-tool call can page the original back (never silent deletion — the full
 * ToolDetail stays durable on the canonical RoomEvent regardless of what this
 * render-time projection shows). Another agent's activity is always a
 * bounded-tail compact stub, independent of recency. */
function boundedActivityPreview(preview: string, policy: ContextDietPolicy, isOwn: boolean, isRecentEvent: boolean, eventId: string, toolId: string): string {
  if (!policy.preset) return preview;
  if (isOwn && (policy.keepAllToolCalls || isRecentEvent)) return preview;
  if (isOwn) {
    const firstLine = preview.split("\n", 1)[0]?.trim() ?? "";
    return `${firstLine} … [collapsed — page the original with tool_result_fetch(sessionId="${eventId}", entryId="${toolId}")]`;
  }
  return preview.split("\n").slice(-Math.max(1, policy.toolTailLines)).join("\n");
}

/** Last `windowSize` distinct agent-authored event ids (nearest the end of
 * `events`, i.e. nearest the current turn) count as "recent" for the own-tool
 * diet rule; `windowSize<=0` recognizes none as recent. */
function recentAgentEventIds(events: readonly RoomEvent[], windowSize: number): ReadonlySet<string> {
  if (windowSize <= 0) return new Set();
  const ids = events.filter((event) => !("targets" in event)).map((event) => event.id);
  return new Set(ids.slice(-windowSize));
}

/** Render room events for a turn prompt (v1's room.ts renderer, verbatim when
 * `diet` is absent or its policy is off). `userName` labels the human's own
 * messages (Settings ▸ General ▸ "Your name" — services/user-name.ts); "" or
 * omitted falls back to the anonymous "user" token this always used before
 * that setting existed.
 *
 * `diet` (09-MEMORY-CONTEXT, opt-in — see ContextPolicyStore, default OFF):
 * when its policy.preset is true, each agent event's tool-call activity
 * (RoomEvent.details.tools — never shown before this) is additionally
 * rendered under a `[gaia.activity]` block, decayed per boundedActivityPreview.
 * The canonical RoomEvent is never mutated — this is a render-time projection
 * only, exactly like v2's diet projection. */
export function renderRoomTranscript(events: RoomEvent[], userName?: string, diet?: DietRenderContext): string {
  if (events.length === 0) return "(empty room)";
  const who = userName?.trim() || "user";
  const recent = diet?.policy.preset ? recentAgentEventIds(events, diet.policy.fullTurnWindow) : undefined;

  return events
    .map((event) => {
      const header =
        "targets" in event
          ? `${who} -> ${event.targets.map((target: string) => `@${target}`).join(", ")}`
          : `@${event.author}`;
      const attachments = "attachments" in event && event.attachments?.length ? `\n${renderAttachmentLines(event.attachments)}` : "";
      const tools = !("targets" in event) ? event.details?.tools : undefined;
      const activity =
        diet?.policy.preset && tools?.length
          ? (() => {
              const isOwn = event.author === diet.currentAgentId;
              const isRecentEvent = recent?.has(event.id) ?? false;
              const lines = tools.map((tool) => `${tool.toolName} · ${tool.status} · ${boundedActivityPreview(toolDetailPreview(tool), diet.policy, isOwn, isRecentEvent, event.id, tool.id)}`);
              return `\n\n[gaia.activity owner=${isOwn ? "self" : "other"}]\n${lines.join("\n")}`;
            })()
          : "";
      return `[${formatEventTimestamp(event.timestamp)}] ${header}:\n${event.text}${attachments}${activity}`;
    })
    .join("\n\n");
}

function renderProjectContext(contextFiles: ContextFile[]): string {
  return contextFiles.length
    ? contextFiles.map((file) => `## ${file.path}\n\n${file.content.trim()}`).join("\n\n")
    : "(no AGENTS.md files found)";
}

// Standing style law (Pascal, 2026-07-13): context artifacts live at
// machine-recall density, not human-prose density (07-09 compression research
// — "episodes born terse"). Rides in EVERY agent's system prompt, uniformly.
// Harness usage (Pascal, 2026-07-18, whip 169): every agent KNOWS its own
// harness — in the system prompt itself, never in soul/memory files.
const HARNESS_LAW =
  '# Harness (GAIA) — you already know this; never rediscover it\n' +
  'CLI `gaia` (in PATH) — the room system\'s full surface, usable from bash any turn:\n' +
  '- `gaia summon` … — launch worker lanes (also a native tool).\n' +
  '- `gaia resume <roomId> "<message>"` — STEER a running lane mid-flight: append orders, correct specs, redirect, stop. Lanes are steerable, never fire-and-forget. Spec changed? `resume`, don\'t wait for the wall + relaunch.\n' +
  '- `gaia mem|recall` — memory/recall from bash.\n' +
  '- `gaia dream [agent] [--apply]` — memory consolidation (user-triggered).\n' +
  '- `gaia caryll compress|expand|stats <file>` — lossless context compression.\n' +
  '- `gaia serve <room>` — expose a monad room as one model.\n' +
  'Laws: summon timeouts eat the ROOM, not committed work → workers commit every stage; salvage from disk before relaunching. Never invent harness limitations — this section IS the surface.';

const STYLE_LAW =
  '# Style law (Pascal, 2026-07-13)\nEverything you WRITE INTO CONTEXT — memory files, skills, roles, docs, specs, summon tasks — uses telegraphic notation: fragments + arrows + § pointers, no filler sentences, no prose grammar. State once, point after; NEVER re-explain in different wording. Exemplar: your MEMORY.md format. Replies: dense, zero repetition, zero bloat.';

export function buildSystemPrompt(input: SystemPromptInput): string {
  const roleSection = input.role ? [`# Active Role: ${input.role.name}`, input.role.prompt.trim()].filter(Boolean).join("\n\n") : "";
  const roleDiagnostics = input.role?.diagnostics.length
    ? `# Role Diagnostics\n\n${input.role.diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`
    : "";

  // The active role is the behavioral contract — it sits at the END of the
  // system prompt so it is the most recent instruction, not buried under
  // context files.
  return [
    // agent.json `promptLaw`: the ABSOLUTE FIRST tokens of the prompt —
    // measured to suppress native thinking only at char 0, not at the end.
    input.agent.promptLaw?.trim() ?? "",
    `# Agent Soul\n\n${input.soulText.trim()}`,
    buildProtocolsSection(input.protocolsText, input.thinkingLevel),
    input.intentText?.trim() ? `# Project Agent Intent\n\n${input.intentText.trim()}` : "",
    `# Project Context (AGENTS.md)\n\n${renderProjectContext(input.contextFiles)}`,
    HARNESS_LAW,
    STYLE_LAW,
    roleSection,
    roleDiagnostics,
    "You are participating in a shared GAIA room with other people and agents. Reply only as the current agent. Address whoever you are speaking to directly, in the second person (\"you\") — even when several participants are present, do not narrate about them in the third person as if they were absent. Third person is right only for people genuinely not in the room.",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** Read a file, returning "" for a missing path or read failure. */
export async function readOptional(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

// Reads soul + optional project-intent + the workspace's AGENTS.md off disk at
// call time and composes the base system prompt. SessionMap-backed runtimes
// serve this builder through SessionMap.systemPrompt, so disk reads happen only
// at session birth, /compact, /clear, /refresh, or a role switch — never
// mid-conversation otherwise.
export async function buildBaseSystemPrompt(params: {
  agent: AgentDef;
  role: ResolvedRole | undefined;
  workspaceRoot: string;
  /** Room-scoped GAIA-THINK level (0-10). Unset = 0. */
  thinkingLevel?: number;
  /** Override the protocols source dir (tests); defaults to ~/.gaia/protocols. */
  protocolsDir?: string;
}): Promise<string> {
  const [soulText, intentText, contextFiles, protocolsText] = await Promise.all([
    readFile(params.agent.soulPath, "utf8"),
    readOptional(params.agent.projectIntentPath),
    discoverContextFiles(params.workspaceRoot),
    readProtocolsText(params.protocolsDir),
  ]);
  return buildSystemPrompt({
    agent: params.agent,
    soulText,
    role: params.role,
    intentText,
    contextFiles,
    protocolsText,
    thinkingLevel: params.thinkingLevel,
  });
}

// CLI harnesses (Claude, Codex) can't load Pi-style skill files, so the active
// role's skill text is inlined into the system prompt, followed by a one-line
// pointer to the `gaia` CLI. Shared by every inline (subprocess) harness.
export async function buildInlineSystemPrompt(params: {
  workspace: Workspace;
  agent: AgentDef;
  role: ResolvedRole | undefined;
  toolPointer: string;
  /** Room-scoped GAIA-THINK level (0-10). Unset = 0. */
  thinkingLevel?: number;
}): Promise<string> {
  const base = await buildBaseSystemPrompt({
    agent: params.agent,
    role: params.role,
    workspaceRoot: params.workspace.rootDir,
    thinkingLevel: params.thinkingLevel,
  });
  // A harness's native commands (claude builtins like deep-research) have no
  // SKILL.md to inline — they reach the agent by passthrough. Pass their names as
  // "known external" so an unresolved one is skipped silently, not inlined and
  // not warned as "unknown skill". Reuses loadSkillText's single scan (the memo'd
  // nativeCommandsFor adds no disk I/O) — no second discoverSkills on the turn path.
  const nativeNames = new Set(nativeCommandsFor(harnessIdFor(params.agent, params.workspace)).map((command) => command.name.toLowerCase()));
  const skills = await loadSkillText(params.workspace, agentSkillNames(params.agent, params.role), undefined, nativeNames);
  for (const diagnostic of skills.diagnostics) console.warn(diagnostic);
  return [base, skills.text, params.toolPointer].filter(Boolean).join("\n\n---\n\n");
}

// Self-contained `gaia` CLI documentation for whichever tools the agent has
// AND the harness can wire (`supported`). Static and live-derived pointers flow
// through the same resolver; agents never need a separate documentation lookup.
export function resolvePointer(spec: GaiaToolSpec, context: PointerContext): string {
  return typeof spec.pointer === "function" ? spec.pointer(context) : spec.pointer;
}

export function gaiaCliPointer(
  tools: string[],
  supported: readonly string[] = gaiaToolIds(),
  context: PointerContext = { availableAgents: [] },
): string {
  const lines = GAIA_TOOLS.filter((tool) => tools.includes(tool.id) && supported.includes(tool.id)).map((tool) =>
    resolvePointer(tool, context),
  );
  if (!lines.length) return "";
  return [
    "# GAIA tools (run via shell)",
    "You have a ready-to-use `gaia` CLI on your PATH (already wired to this daemon — just run it, no setup, no hunting for the binary):",
    ...lines,
  ].join("\n");
}

/**
 * The uniform per-turn composition EVERY runtime performs: read the agent's
 * persistent memory, diff it against what this room's session last saw
 * (SessionMap.memoryChanged — memory travels in the turn prompt only when it
 * changed, so a memory write never forces a session reload), then map the
 * AgentInput onto buildTurnPrompt. Hoisted here so a new AgentInput field is
 * threaded in exactly ONE place; the stores/session-map stay whatever the
 * calling harness composed — never a harness-id branch.
 */
export async function buildTurnPromptFor(
  agent: Pick<AgentDef, "id" | "memoryDir" | "turnLaw">,
  input: AgentInput,
  memoryStore: Pick<MemoryStore, "promptBlock">,
  sessions: { memoryChanged(roomId: string, memory: string): boolean },
  /** This runtime's own cwd (RunnerHost's per-room worktree or workspace
   * root) and the workspace root it was cloned from — see TurnPromptInput. */
  paths?: { workDir: string; rootDir: string },
): Promise<string> {
  const memory = await memoryStore.promptBlock(agent.memoryDir);
  const memoryChanged = sessions.memoryChanged(input.roomId, memory);
  return buildTurnPrompt({
    roomId: input.roomId,
    agentId: agent.id,
    message: input.message,
    events: input.transcript,
    dietPolicy: input.dietPolicy,
    memory: memoryChanged ? memory : undefined,
    recall: input.recall,
    pluginContext: input.pluginContext,
    channel: input.channel,
    attachments: input.attachments,
    workDir: paths?.workDir,
    rootDir: paths?.rootDir,
    userName: input.userName,
    turnLaw: agent.turnLaw,
  });
}

export function buildTurnPrompt(input: TurnPromptInput): string {
  const worktreeLine =
    input.workDir && input.rootDir && input.workDir !== input.rootDir
      ? `Worktree: you are working in ${input.workDir} on this room's git branch — an isolated checkout of ${input.rootDir}. Commit your work; it is not in the main checkout until merged.`
      : "";
  return [
    `Room: ${input.roomId}`,
    `Current agent: @${input.agentId}`,
    worktreeLine,
    input.channel === "voice" ? VOICE_MODE_INSTRUCTIONS : "",
    input.memory?.trim() ? `# Your persistent memory\n\n${input.memory.trim()}` : "",
    input.recall?.trim() ?? "",
    input.pluginContext?.trim() ?? "",
    "New room events since your last turn:",
    renderRoomTranscript(input.events, input.userName, input.dietPolicy ? { policy: input.dietPolicy, currentAgentId: input.agentId } : undefined),
    "Newest user message:",
    [input.message, input.attachments?.length ? renderAttachmentLines(input.attachments) : ""].filter(Boolean).join("\n"),
    input.turnLaw?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
