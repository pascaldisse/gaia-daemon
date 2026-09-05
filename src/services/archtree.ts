// Archtree root lanes reuse the ordinary summon coordinator: one lifecycle,
// heartbeat, durable delivery record, and room-tree registration everywhere.
import type { Workspace } from "../core/types.js";
import { loadSkillText } from "../domain/skills.js";
import type { SummonHost } from "./summons.js";

export interface ArchtreeRootRequest {
  workspace: Pick<Workspace, "rootDir" | "dir">;
  ownWorktree?: boolean;
  parentRoomId: string;
  agentId: string;
  task: string;
  /** Present for an agent-originated root: deliver result + callback to it. */
  callerAgentId?: string;
}

export async function addArchtreeRoot(coordinator: Pick<SummonHost, "summon">, request: ArchtreeRootRequest): Promise<string> {
  const task = request.task.trim();
  if (!task) throw new Error("Usage: archtree add-root [--agent <agent>] <task>");
  const agentId = request.agentId.trim();
  if (!agentId) throw new Error("An agent is required to add an archtree root.");
  const skill = await loadSkillText(request.workspace, ["gaia-archtree"]);
  if (skill.diagnostics.length || !skill.text.trim()) {
    throw new Error(`Archtree skill unavailable: ${skill.diagnostics.join("; ") || "empty skill"}`);
  }
  const prompt = [skill.text, "# Root branch\nScope → assigned task only · existing tree → preserve · skill laws → every delegated child", `# Task\n${task}`].join("\n\n");
  return coordinator.summon(request.parentRoomId, agentId, prompt, {
    ownWorktree: request.ownWorktree ?? true,
    ...(request.callerAgentId ? { deliver: "turn" as const, callerAgentId: request.callerAgentId } : { deliver: "note" as const }),
  });
}
