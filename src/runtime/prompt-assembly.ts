import type { AgentDefinition } from "../agents/types.js";
import { renderRoomTranscript } from "../room/room.js";
import type { RoomEvent } from "../room/transcript.js";
import type { ResolvedRole } from "../roles/roles.js";
import type { ContextFile } from "../workspace/types.js";

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
