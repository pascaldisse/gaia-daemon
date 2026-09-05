import { cleanSummaryIndexPath, registerCleanSummary } from "../../domain/clean-summaries.js";
import type { SlashCommand } from "../commands.js";
import type { RoomCommandsFacadePort } from "./ports.js";

type CleanCommandPort = Pick<RoomCommandsFacadePort, "workspace" | "runtimes" | "roomId" | "activeAgentTurn" | "compactingAgents" | "roomDefaultTarget" | "unknownAgentMessage"> & {
  runDscCompactCommand(agent?: string): ReturnType<RoomCommandsFacadePort["finishCompactCommand"]>;
};
// Separate entry point; /compact and its edit/auto paths remain unchanged.
export async function runCompactCleanCommand(
  service: CleanCommandPort,
  command: Extract<SlashCommand, { type: "compact-clean" }>,
  indexPath = cleanSummaryIndexPath(),
): ReturnType<RoomCommandsFacadePort["finishCompactCommand"]> {
  const target = command.agent ?? await service.roomDefaultTarget();
  if (!service.workspace.agents[target]) return service.unknownAgentMessage(target);
  const runtime = service.runtimes[target];
  if (!runtime?.capabilities.supportsCompact || !runtime.compactClean) return `@${target}'s harness has no clean compaction.`;
  if (service.activeAgentTurn) return "A turn is running — /cancel it first, or wait for it to finish.";
  if (service.compactingAgents.has(target)) return `@${target}: compaction already running.`;
  if (command.summary !== undefined) {
    if (!command.summary.trim()) return "Usage: /compact-clean [agent] [--summary <non-empty clean summary>]";
    service.compactingAgents.add(target);
    try { await registerCleanSummary(service.roomId, target, command.summary, indexPath); }
    catch (error) { return `Clean summary registration failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { service.compactingAgents.delete(target); }
  }
  return service.runDscCompactCommand(target);
}
