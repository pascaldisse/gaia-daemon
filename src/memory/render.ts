import type { MemoryState } from "./memory-store.js";

export function renderAgentMemory(state: MemoryState): string {
  return `# Agent Memory\n\n${state.content.trim() || "(empty)"}`;
}
