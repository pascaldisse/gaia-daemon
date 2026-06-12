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
}

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
    input.memory?.trim() ? `Your persistent memory (MEMORY.md):\n\n${input.memory.trim()}` : "",
    "New room events since your last turn:",
    renderRoomTranscript(input.events),
    "Newest user message:",
    input.message,
    "Respond to the newest user message in your own voice. Be concise and useful.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
