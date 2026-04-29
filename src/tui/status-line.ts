import type { Mode } from "../personas/types.js";
import { PERSONAS } from "../personas/types.js";

export function renderStatusLine(mode: Mode, modelLabel: string): string {
  const persona = PERSONAS[mode];
  return `[${persona.icon} ${persona.displayName}] model: ${modelLabel}`;
}
