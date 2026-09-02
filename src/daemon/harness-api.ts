import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { workspacePaths } from "../core/paths.js";
import type { Workspace } from "../core/types.js";
import { capabilitiesFor, type ContextDietView, type GaiaTool, harnessIdFor } from "../harness/spec.js";
import type { ContextDietOverrides } from "../domain/context-diet.js";
import type { MemoryAction, MemoryMutationResult } from "../domain/memory.js";
import { RoomHandle } from "../domain/rooms.js";
import { formatDreamProposal } from "../services/consolidate.js";
import type { MemorySearchHit } from "../domain/workspace-index.js";
import { formatMemoryHits, scrollTranscriptWindow } from "../domain/workspace-index.js";
import type { HarnessTokenClaims } from "../services/bridge.js";
import type { ToolProviders } from "../harness/protocol.js";
import type { HarnessApiPort } from "./ports.js";
export function harnessGaiaTools(workspace: Workspace, agentId: string): readonly GaiaTool[] {
  return capabilitiesFor(harnessIdFor(workspace.agents[agentId], workspace)).gaiaTools;
}

export function harnessToolProviders(port: HarnessApiPort): ToolProviders {
  return port.toolProviders;
}

export async function harnessMemoryBatch(port: HarnessApiPort, claims: HarnessTokenClaims, file: string, operations: Array<{ action: MemoryAction; content?: string; oldText?: string }>): Promise<MemoryMutationResult> {
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  return service.mutateAgentMemoryBatch(claims.agentId, file, operations);
}

export async function harnessMemoryWrite(port: HarnessApiPort, claims: HarnessTokenClaims, file: string, action: MemoryAction, options: { content?: string; oldText?: string }): Promise<MemoryMutationResult> {
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  return service.mutateAgentMemory(claims.agentId, file, action, options);
}

export async function harnessRecall(port: HarnessApiPort, claims: HarnessTokenClaims, query: string, limit?: number, options: { summarize?: boolean } = {}): Promise<{ result: string; hits: MemorySearchHit[] }> {
  const record = await port.registry.find(claims.workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  const memory = port.memoryServiceFor(claims.workspaceId, service.workspace, record.path);
  const context = await service.recallContext(claims.agentId);
  const request = { limit: limit && limit > 0 ? Math.min(limit, 25) : undefined, context };
  if (options.summarize) {
    const { text, degraded } = await memory.summarizeSearch(claims.agentId, query, request);
    const header = degraded.length ? `(recall degraded: ${degraded.join("; ")})\n` : "";
    return { result: text ? `${header}${text}` : `${header}no matches in memory or room history`, hits: [] };
  }
  const { hits, degraded } = await memory.deepSearch(claims.agentId, query, request);
  const header = degraded.length ? `(recall degraded: ${degraded.join("; ")})\n` : "";
  return { result: hits.length ? `${header}${formatMemoryHits(hits, { full: true })}` : `${header}no matches in memory or room history`, hits };
}

export async function harnessRecallScroll(port: HarnessApiPort, claims: HarnessTokenClaims, hitId: number, options: { span?: number; offset?: number } = {}): Promise<string> {
  const record = await port.registry.find(claims.workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
  const window = await scrollTranscriptWindow(record.path, hitId, options);
  return window ?? `no transcript hit with id ${hitId} — ids come from recall results ("hit N")`;
}

export async function harnessToolResultFetch(port: HarnessApiPort, claims: HarnessTokenClaims, sessionId: string, entryId: string, offset: number, limit: number): Promise<{ text: string; totalLength: number; hasMore: boolean }> {
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  const slice = await service.toolResultSlice(claims.agentId, sessionId, entryId, offset, limit);
  if (!slice) throw new Error(`No stored tool call for session ${sessionId} entry ${entryId}`);
  return slice;
}

export async function harnessContextDietGet(port: HarnessApiPort, claims: HarnessTokenClaims): Promise<ContextDietView> {
  return (await port.serviceFor(claims.workspaceId, claims.roomId)).dietView();
}

export async function harnessContextDietSet(port: HarnessApiPort, claims: HarnessTokenClaims, scope: "room" | "workspace", patch: ContextDietOverrides): Promise<ContextDietView> {
  return (await port.serviceFor(claims.workspaceId, claims.roomId)).dietSet({ scope, patch });
}

export async function harnessEndConversation(port: HarnessApiPort, claims: HarnessTokenClaims, farewell: string): Promise<string> {
  return (await port.serviceFor(claims.workspaceId, claims.roomId)).endConversation(claims.agentId, farewell);
}

export async function harnessDogCommand(port: HarnessApiPort, claims: HarnessTokenClaims, sub: "on" | "off" | "status"): Promise<string> {
  return (await port.serviceFor(claims.workspaceId, claims.roomId)).runPluginAction("dog", [sub]);
}

export async function harnessGhoulRoomRead(port: HarnessApiPort, claims: HarnessTokenClaims, targetRoomId: string, options: { offset?: number; limit?: number } = {}): Promise<string> {
  const record = await port.registry.find(claims.workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  const caller = service.workspace.agents[claims.agentId];
  if (caller?.insight !== "full") throw new Error(`insight "full" required to read another room's raw transcript (caller '${claims.agentId}' has insight "${caller?.insight ?? "none"}")`);
  if (!existsSync(workspacePaths.roomState(record.path, targetRoomId))) throw new Error(`no such room: ${targetRoomId}`);
  const handle = await RoomHandle.open(record.path, targetRoomId);
  const state = await handle.state();
  if (state.incognito !== true) throw new Error(`'${targetRoomId}' is not an incognito room — read it through normal recall instead`);
  const { events } = await handle.eventsFrom(0);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(1, options.limit ?? 40), 200);
  const window = events.slice(offset, offset + limit);
  if (window.length === 0) return `'${targetRoomId}': no events at offset ${offset} (${events.length} total)`;
  const lines = window.map((event, index) => {
    const shown = event.text.length > 800 ? `${event.text.slice(0, 800)}…` : event.text;
    return `[${offset + index}] ${event.author}: ${shown || "(no text)"}`;
  });
  const consumed = offset + window.length;
  const more = consumed < events.length ? `\n\n… ${events.length - consumed} more events; pass offset=${consumed} to continue` : "";
  return `${targetRoomId} (${events.length} events total, showing ${offset}–${consumed - 1}):\n\n${lines.join("\n")}${more}`;
}

export async function harnessGhoulLedgerSearch(port: HarnessApiPort, claims: HarnessTokenClaims, query?: string): Promise<string> {
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  const caller = service.workspace.agents[claims.agentId];
  if (caller?.insight !== "full") throw new Error(`insight "full" required to search other agents' ledgers (caller '${claims.agentId}' has insight "${caller?.insight ?? "none"}")`);
  const needle = query?.trim().toLowerCase();
  const hits: string[] = [];
  for (const agent of Object.values(service.workspace.agents)) {
    const dir = join(agent.memoryDir, "ledgers");
    let files: string[];
    try { files = (await readdir(dir)).filter((name) => name.endsWith(".md")); } catch { continue; }
    for (const file of files) {
      let content: string;
      try { content = await readFile(join(dir, file), "utf8"); } catch { continue; }
      const entries = content.split(/\n(?=§ )/).filter((entry) => entry.trim());
      for (const entry of entries) if (!needle || entry.toLowerCase().includes(needle)) hits.push(`--- ${agent.id} / ${file} ---\n${entry.trim()}`);
    }
  }
  if (hits.length === 0) return needle ? `no ledger entries matching "${query}"` : "no ledger entries recorded yet";
  return hits.slice(0, 40).join("\n\n");
}

export async function harnessDreamPropose(port: HarnessApiPort, claims: HarnessTokenClaims, agentId: string): Promise<string> {
  const record = await port.registry.find(claims.workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  const result = await port.memoryServiceFor(claims.workspaceId, service.workspace, record.path).consolidate(agentId, { propose: true, force: true });
  return formatDreamProposal(result, "run: gaia dream [agent] --apply to accept, or dream again to regenerate.");
}

export async function harnessDreamApply(port: HarnessApiPort, claims: HarnessTokenClaims, agentId: string): Promise<string> {
  const record = await port.registry.find(claims.workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${claims.workspaceId}`);
  const service = await port.serviceFor(claims.workspaceId, claims.roomId);
  const result = await port.memoryServiceFor(claims.workspaceId, service.workspace, record.path).applyDreamProposal(agentId);
  if (!result) throw new Error(`no pending dream proposal for @${agentId} — run \`gaia dream\` first`);
  return `applied ${result.applied} ops (${result.skipped} skipped)`;
}
