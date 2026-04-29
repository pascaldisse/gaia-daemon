import type { PersonaId } from "../personas/types.js";
import { PERSONAS } from "../personas/types.js";

export function assistantHeader(personaId: PersonaId): string {
  const persona = PERSONAS[personaId];
  return `\n${persona.icon} ${persona.displayName}:`;
}

export function userHeader(): string {
  return "\nYou:";
}

export function toolLine(kind: "start" | "end", toolName: string, extra = ""): string {
  const marker = kind === "start" ? "→" : "←";
  return `\n  ${marker} tool ${toolName}${extra ? ` ${extra}` : ""}`;
}
