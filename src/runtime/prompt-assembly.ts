import { readFile } from "node:fs/promises";
import type { AgentDefinition } from "../agents/types.js";
import { renderRoomTranscript } from "../room/room.js";
import type { RoomEvent } from "../room/transcript.js";
import type { ResolvedRole } from "../roles/roles.js";
import { loadRoleSkillText } from "../skills/skill-resolver.js";
import { GAIA_TOOLS, gaiaToolIds } from "../tools/gaia-tools.js";
import type { ContextFile, Workspace } from "../workspace/types.js";

export interface SystemPromptInput {
  agent: AgentDefinition;
  soulText: string;
  role?: ResolvedRole;
  intentText?: string;
  contextFiles: ContextFile[];
}

export interface TurnPromptInput {
  roomId: string;
  agentId: string;
  message: string;
  events: RoomEvent[];
  // Persistent memory content, included only when it changed since the last
  // turn so memory writes do not force a session reload mid-conversation.
  memory?: string;
  channel?: "text" | "voice";
}

// Turn-level overlay (not the system prompt) so entering/leaving a call never
// forces a Pi session reload.
const VOICE_MODE_INSTRUCTIONS = [
  "Voice mode: you are on a live voice call with the user. Your reply will be spoken aloud by a text-to-speech engine.",
  "The user's words were transcribed by speech-to-text and may contain transcription mistakes; if something seems off, guess the likely intent rather than asking.",
  "Keep replies short and conversational - a few spoken sentences unless asked for more.",
  "Plain prose only: no markdown, no headings, no bullet points, no code blocks, no emojis. Everything you write is pronounced literally.",
  "Write numbers, abbreviations and symbols the way they should be spoken.",
  "You can still use your tools; the user only hears your final text.",
].join("\n");

function renderProjectContext(contextFiles: ContextFile[]): string {
  return contextFiles.length
    ? contextFiles.map((file) => `## ${file.path}\n\n${file.content.trim()}`).join("\n\n")
    : "(no AGENTS.md files found)";
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const roleSection = input.role ? [`# Active Role: ${input.role.name}`, input.role.prompt.trim()].filter(Boolean).join("\n\n") : "";
  const roleDiagnostics = input.role?.diagnostics.length
    ? `# Role Diagnostics\n\n${input.role.diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`
    : "";

  return [
    `# Agent Soul\n\n${input.soulText.trim()}`,
    roleSection,
    input.intentText?.trim() ? `# Project Agent Intent\n\n${input.intentText.trim()}` : "",
    `# Project Context (AGENTS.md)\n\n${renderProjectContext(input.contextFiles)}`,
    roleDiagnostics,
    "You are participating in a shared GAIA room. Reply only as the current agent.",
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

// Reads soul + optional project-intent off disk and composes the base system
// prompt. Every harness needs this exact read-then-assemble step.
export async function buildBaseSystemPrompt(params: {
  agent: AgentDefinition;
  role: ResolvedRole | undefined;
  contextFiles: ContextFile[];
}): Promise<string> {
  const [soulText, intentText] = await Promise.all([
    readFile(params.agent.soulPath, "utf8"),
    readOptional(params.agent.projectIntentPath),
  ]);
  return buildSystemPrompt({
    agent: params.agent,
    soulText,
    role: params.role,
    intentText,
    contextFiles: params.contextFiles,
  });
}

// CLI harnesses (Claude, Codex) can't load Pi-style skill files, so the active
// role's skill text is inlined into the system prompt, followed by a one-line
// pointer to the `gaia` CLI. Shared by every inline (subprocess) harness.
export async function buildInlineSystemPrompt(params: {
  workspace: Workspace;
  agent: AgentDefinition;
  role: ResolvedRole | undefined;
  toolPointer: string;
}): Promise<string> {
  const base = await buildBaseSystemPrompt({
    agent: params.agent,
    role: params.role,
    contextFiles: params.workspace.contextFiles,
  });
  const skills = await loadRoleSkillText(params.workspace, params.role);
  for (const diagnostic of skills.diagnostics) console.warn(diagnostic);
  return [base, skills.text, params.toolPointer].filter(Boolean).join("\n\n---\n\n");
}

// Progressive-disclosure pointer to the `gaia` CLI for whichever of
// memory/recall/summon the agent has AND the harness can wire (`supported`).
// Near-zero context until the agent runs `gaia <cmd> --help`.
export function gaiaCliPointer(tools: string[], supported: readonly string[] = gaiaToolIds()): string {
  const lines = GAIA_TOOLS.filter((tool) => tools.includes(tool.id) && supported.includes(tool.id)).map((tool) => tool.pointer);
  if (!lines.length) return "";
  return [
    "# GAIA tools (run via shell)",
    "You have a ready-to-use `gaia` CLI on your PATH (already wired to this daemon — just run it, no setup, no hunting for the binary):",
    ...lines,
  ].join("\n");
}

export function buildTurnPrompt(input: TurnPromptInput): string {
  return [
    `Room: ${input.roomId}`,
    `Current agent: @${input.agentId}`,
    input.channel === "voice" ? VOICE_MODE_INSTRUCTIONS : "",
    input.memory?.trim() ? `# Your persistent memory\n\n${input.memory.trim()}` : "",
    "New room events since your last turn:",
    renderRoomTranscript(input.events),
    "Newest user message:",
    input.message,
    "Respond to the newest user message in your own voice. Be concise and useful.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
