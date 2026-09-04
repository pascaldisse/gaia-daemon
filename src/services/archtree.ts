// Archtree root lanes reuse the ordinary summon coordinator: one lifecycle,
// heartbeat, durable delivery record, and room-tree registration everywhere.
import type { SummonHost } from "./summons.js";

export interface ArchtreeRootRequest {
  parentRoomId: string;
  agentId: string;
  task: string;
  /** Present for an agent-originated root: deliver result + callback to it. */
  callerAgentId?: string;
}

export async function addArchtreeRoot(coordinator: SummonHost, request: ArchtreeRootRequest): Promise<string> {
  const task = request.task.trim();
  if (!task) throw new Error("Usage: archtree add-root [--agent <agent>] <task>");
  const agentId = request.agentId.trim();
  if (!agentId) throw new Error("An agent is required to add an archtree root.");
  return coordinator.summon(request.parentRoomId, agentId, task, request.callerAgentId
    ? { deliver: "turn", callerAgentId: request.callerAgentId }
    : { deliver: "note" });
}
