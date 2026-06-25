// The default policy: no ML, no weights, no Python. Each turn it asks the
// coordinator model to pick the next {agent, role, subtask} (or ACCEPT) given the
// pool, the roles, and the transcript — this is the "dynamic" monad, and per the
// Conductor de-risking finding it captures most of Fugu's value with zero
// training. When the model is unavailable or its reply doesn't parse, it falls
// back to a deterministic Thinker → Worker → Verifier cycle, so the monad always
// makes progress (and is testable with no model at all).

import { registerRoutingPolicy } from "../policy-registry.js";
import type { MonadObservation, MonadOutcome, MonadSlot, RouteDecision, RoutingPolicy, RoutingPolicyContext } from "../types.js";
import { extractJsonObject, lastStepWithRole, replyAccepts } from "../util.js";

interface PromptDrivenConfig {
  /** Default accept token if the room config carries none. */
  acceptToken?: string;
}

const ROUTING_SYSTEM = `You are the coordinator (the "monad") of a small team. You do not answer the user yourself; you route the next step to ONE teammate and write its instruction, then stop. Reply with ONLY a JSON object, no prose.`;

function acceptTokenFor(ctx: RoutingPolicyContext, fallback: string): string {
  return ctx.terminate?.acceptToken ?? fallback;
}

function slotForRole(slots: MonadSlot[], role: string): MonadSlot | undefined {
  return slots.find((slot) => slot.defaultRole === role) ?? slots.find((slot) => slot.label === role);
}

function slotForAgent(slots: MonadSlot[], agentId: string): MonadSlot | undefined {
  return slots.find((slot) => slot.agentId === agentId);
}

function defaultSubtask(role: string, obs: MonadObservation, acceptToken: string): string {
  if (role === "thinker") {
    return `Plan and decompose how to answer this request: "${obs.query}". Give the worker a concrete, actionable plan. Do not write the final answer yourself.`;
  }
  if (role === "verifier") {
    return `Check the worker's latest result for correctness and completeness against the request: "${obs.query}". Begin your reply with ${acceptToken} if it is fully correct, otherwise REVISE followed by exactly what to fix.`;
  }
  // worker
  const revising = lastStepWithRole(obs, "verifier");
  if (revising && !replyAccepts(revising.reply, acceptToken)) {
    return `Revise your work to address the verifier's feedback, then produce the complete, corrected result for: "${obs.query}".`;
  }
  return `Carry out the plan and produce the most complete, correct result you can for: "${obs.query}".`;
}

// Deterministic Thinker → Worker → Verifier cycle. Always returns a dispatch (or
// accept when there is no verifier to consult). This is the floor the model-led
// path falls back to; it also fully drives the loop when no model is available.
function ruleNext(obs: MonadObservation, ctx: RoutingPolicyContext, acceptToken: string): MonadOutcome {
  const haveVerifier = Boolean(slotForRole(ctx.slots, "verifier"));
  const haveThinker = Boolean(slotForRole(ctx.slots, "thinker"));

  let role: string;
  if (obs.steps.length === 0) {
    role = haveThinker ? "thinker" : "worker";
  } else {
    const last = obs.steps[obs.steps.length - 1];
    if (last.role === "thinker") role = "worker";
    else if (last.role === "worker") {
      if (!haveVerifier) return { kind: "accept", finalStepIndex: last.index };
      role = "verifier";
    } else {
      // A verifier step that did NOT accept (acceptance is caught earlier) ⇒ rework.
      role = "worker";
    }
  }

  const slot = slotForRole(ctx.slots, role) ?? ctx.slots[0];
  const decision: RouteDecision = {
    agentId: slot.agentId,
    role,
    subtask: defaultSubtask(role, obs, acceptToken),
    sees: "all",
  };
  return { kind: "dispatch", decision };
}

// Parse a model routing reply into an outcome, or undefined if it doesn't parse
// into a valid decision over the configured pool.
function parseDecision(reply: string, obs: MonadObservation, ctx: RoutingPolicyContext): MonadOutcome | undefined {
  const parsed = extractJsonObject(reply) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;

  const action = typeof parsed.action === "string" ? parsed.action.toLowerCase() : undefined;
  if (action === "accept" || parsed.accept === true) {
    const lastWorker = lastStepWithRole(obs, "worker");
    return { kind: "accept", ...(lastWorker ? { finalStepIndex: lastWorker.index } : {}) };
  }

  const roleRaw = typeof parsed.role === "string" ? parsed.role.toLowerCase().trim() : undefined;
  const agentRaw = typeof parsed.agent === "string" ? parsed.agent.replace(/^@/, "").trim() : undefined;

  // Resolve the slot: an explicit valid agent wins; otherwise map by role.
  const slot =
    (agentRaw ? slotForAgent(ctx.slots, agentRaw) : undefined) ?? (roleRaw ? slotForRole(ctx.slots, roleRaw) : undefined);
  if (!slot) return undefined;

  const role = roleRaw ?? slot.defaultRole ?? slot.label ?? "worker";
  const acceptToken = acceptTokenFor(ctx, "ACCEPT");
  const subtask = typeof parsed.subtask === "string" && parsed.subtask.trim() ? parsed.subtask.trim() : defaultSubtask(role, obs, acceptToken);
  const sees = parseSees(parsed.sees, obs);

  return { kind: "dispatch", decision: { agentId: slot.agentId, role, subtask, sees } };
}

function parseSees(value: unknown, obs: MonadObservation): number[] | "all" {
  if (value === "all" || value === undefined || value === null) return "all";
  if (Array.isArray(value)) {
    const valid = obs.steps.map((step) => step.index);
    const indices = value.filter((entry): entry is number => typeof entry === "number" && valid.includes(entry));
    return indices;
  }
  return "all";
}

function routingPrompt(obs: MonadObservation, ctx: RoutingPolicyContext, acceptToken: string): string {
  const pool = ctx.slots
    .map((slot) => `  - agent "${slot.agentId}" → role "${slot.defaultRole ?? slot.label ?? "worker"}"${slot.label ? ` (${slot.label})` : ""}`)
    .join("\n");
  return [
    `Original request:\n${obs.query}`,
    `Team (pick exactly one agent for the next step):\n${pool}`,
    `Roles available: ${ctx.roles.join(", ")}`,
    obs.steps.length > 0 ? `Conversation so far:\n${obs.transcript}` : `No steps have run yet.`,
    `Decide the next step. Reply with ONLY a JSON object:`,
    `  {"action":"dispatch","agent":"<id>","role":"<role>","subtask":"<one clear instruction>","sees":"all"}`,
    `or, once the latest result is correct and complete:`,
    `  {"action":"accept"}`,
    `Route to the verifier role when there is fresh worker output to check; accept only after the verifier replies "${acceptToken}".`,
  ].join("\n\n");
}

class PromptDrivenPolicy implements RoutingPolicy {
  readonly id = "prompt-driven";
  constructor(private readonly config: PromptDrivenConfig) {}

  async next(obs: MonadObservation, ctx: RoutingPolicyContext): Promise<MonadOutcome> {
    const acceptToken = acceptTokenFor(ctx, this.config.acceptToken ?? "ACCEPT");

    // Cheap deterministic stop: the verifier already accepted the latest work.
    const lastVerifier = lastStepWithRole(obs, "verifier");
    if (lastVerifier && replyAccepts(lastVerifier.reply, acceptToken)) {
      const lastWorker = lastStepWithRole(obs, "worker");
      return { kind: "accept", finalStepIndex: lastWorker?.index ?? lastVerifier.index };
    }

    // Dynamic, model-led routing. Falls back to the rule cycle on any failure.
    try {
      const reply = await ctx.invoke(ctx.coordinatorAgentId, [
        { role: "system", content: ROUTING_SYSTEM },
        { role: "user", content: routingPrompt(obs, ctx, acceptToken) },
      ]);
      const decision = parseDecision(reply, obs, ctx);
      if (decision) return decision;
    } catch {
      // Model unavailable / errored — use the deterministic floor below.
    }
    return ruleNext(obs, ctx, acceptToken);
  }
}

registerRoutingPolicy({
  id: "prompt-driven",
  ui: { label: "Prompt-driven", description: "A coordinator model routes each turn; falls back to a fixed Thinker→Worker→Verifier cycle. No ML." },
  create: (config) => new PromptDrivenPolicy((config ?? {}) as PromptDrivenConfig),
});

// Exported for unit tests of the routing logic without the registry.
export { PromptDrivenPolicy };
