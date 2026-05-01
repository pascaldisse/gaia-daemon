import type { AgentDefinition } from "../agents/types.js";

export function assistantHeader(agent: AgentDefinition): string {
  return `\n${agent.icon} ${agent.displayName}:`;
}

export function toolLine(kind: "start" | "end", toolName: string, extra = ""): string {
  const marker = kind === "start" ? "→" : "←";
  return `\n  ${marker} tool ${toolName}${extra ? ` ${extra}` : ""}`;
}
