import { DEFAULT_CONTEXT_DIET_POLICY } from "../../domain/context-diet.js";
import { estimateTokens } from "../../core/tokens.js";
import type { AgentDef, ContextGatePending, MessageAttachment } from "../../core/types.js";
import { contextWindowFor, harnessIdFor } from "../../harness/spec.js";
import { readUserNameSetting } from "../user-name.js";
import { renderRoomTranscript } from "../../harness/prompt.js";

const CONTEXT_GATE_LAST_N = 20;
const CONTEXT_SUMMARY_SYSTEM = [
  "You are compacting a group-chat room transcript so a NEW participant can catch up fast.",
  "Write a tight briefing that preserves: the current topic, key facts and decisions, open questions,",
  "who said what that still matters, and any commitments or next steps. Drop small talk and resolved tangents.",
  "Use short sections or bullets. Do not add commentary about the summary itself.",
].join(" ");
const MAX_SUMMARY_INPUT_CHARS = 100_000;

/** RoomService context-size gate. The host is deliberately structural: this is
 * orchestration shared with the façade without learning about a harness. */
type ContextGateHost = any;

export async function openContextGate(
  service: ContextGateHost,
  agent: AgentDef,
  message: string,
  estTokens: number,
  totalEvents: number,
  attachments: MessageAttachment[] | undefined,
  reason: "new-agent" | "session-lost",
): Promise<void> {
  const window = contextWindowFor(harnessIdFor(agent, service.workspace), agent.model?.name);
  const gate: ContextGatePending = {
    agentId: agent.id,
    message,
    estTokens,
    totalEvents,
    ...(window ? { window } : {}),
    ...(attachments?.length ? { attachments } : {}),
    reason,
    at: new Date().toISOString(),
  };
  await service.room.updateState((current: any) => {
    current.contextGate = gate;
  });
  service.contextGate = gate;
  await service.emitSnapshot();
}

export async function resolveContextGate(service: ContextGateHost, choice: "full" | "last" | "compact", n?: number): Promise<void> {
  await service.init();
  const gate = service.contextGate ?? (await service.room.state()).contextGate;
  if (!gate) return;
  await service.room.updateState((current: any) => {
    delete current.contextGate;
  });
  service.contextGate = undefined;
  await service.emitSnapshot();

  const base: any = {
    targets: [gate.agentId],
    recordUserMessage: false,
    bypassContextGate: true,
    ...(gate.attachments?.length ? { attachments: gate.attachments } : {}),
  };
  if (choice === "last") {
    const keep = Number.isInteger(n) && (n as number) > 0 ? (n as number) : CONTEXT_GATE_LAST_N;
    const start = Math.max(0, gate.totalEvents - keep);
    await setContextFloor(service, gate.agentId, start);
    await service.sendMessage(gate.message, { ...base, cursorOverride: start });
    return;
  }
  if (choice === "compact") {
    const summary = await summarizeRoom(service, gate.agentId, gate.totalEvents);
    await setContextFloor(service, gate.agentId, gate.totalEvents);
    await service.sendMessage(gate.message, {
      ...base,
      cursorOverride: gate.totalEvents,
      recallOverride: `Summary of the conversation so far (compacted for you only):\n\n${summary}`,
    });
    return;
  }
  await setContextFloor(service, gate.agentId, 0);
  await service.sendMessage(gate.message, { ...base, cursorOverride: 0 });
}

export async function setContextFloor(service: ContextGateHost, agentId: string, floorIdx: number): Promise<void> {
  await service.room.updateState((current: any) => {
    if (floorIdx <= 0) {
      if (current.contextFloors) delete current.contextFloors[agentId];
      return;
    }
    current.contextFloors = { ...(current.contextFloors ?? {}), [agentId]: floorIdx };
  });
}

export async function recallContext(service: ContextGateHost, agentId: string): Promise<{ roomId: string; floorIdx: number }> {
  await service.init();
  const state = await service.room.state();
  return { roomId: service.roomId, floorIdx: state.contextFloors?.[agentId] ?? 0 };
}

export async function summarizeRoom(service: ContextGateHost, target: string, uptoEvents: number): Promise<string> {
  const { events } = await service.room.eventsFrom(0);
  const rendered = renderRoomTranscript(events.slice(0, uptoEvents), await readUserNameSetting(), { policy: DEFAULT_CONTEXT_DIET_POLICY, currentAgentId: target });
  const input = rendered.length > MAX_SUMMARY_INPUT_CHARS
    ? `[…earlier history omitted for length…]\n\n${rendered.slice(-MAX_SUMMARY_INPUT_CHARS)}`
    : rendered;
  const llm = service.options.llm;
  if (!llm) return input.slice(-4000);
  service.compactingAgents.add(target);
  service.compactProgress.set(target, { startedAt: Date.now(), contextTokens: estimateTokens(input) });
  await service.emitSnapshot();
  try {
    const summary = await llm({ system: CONTEXT_SUMMARY_SYSTEM, user: input });
    const text = summary.trim() || input.slice(-4000);
    const prev = service.compactProgress.get(target);
    if (prev) service.compactProgress.set(target, { ...prev, outputTokens: estimateTokens(text) });
    return text;
  } catch {
    return input.slice(-4000);
  } finally {
    service.compactingAgents.delete(target);
    service.compactProgress.delete(target);
    await service.emitSnapshot();
  }
}
