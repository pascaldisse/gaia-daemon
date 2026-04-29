import type { MemoryState } from "./memory-store.js";

function percent(state: MemoryState): string {
  return `${Math.round(state.usage * 100)}%`;
}

export function renderMemoryBlock(title: string, state: MemoryState): string {
  return `## ${title}\n\nUsage: ${state.chars}/${state.limit} chars (${percent(state)})\nPath: ${state.path}\n\n${state.content.trim() || "(empty)"}`;
}

export function renderStartupMemory(snapshot: { user: MemoryState; persona?: MemoryState }): string {
  const blocks = [renderMemoryBlock("Shared user memory snapshot", snapshot.user)];
  if (snapshot.persona) blocks.push(renderMemoryBlock("Persona memory snapshot", snapshot.persona));
  return `# Frozen startup memory\n\nMemory is a snapshot from session start. Writes are persisted immediately, but this prompt updates only on the next session.\n\n${blocks.join("\n\n---\n\n")}`;
}
