// Fugu-Ultra / Conductor as a policy. On turn 0 it asks the conductor model for a
// whole workflow — three equal-length lists (model_id / subtasks / access_list)
// in openfugu/ultra.py, here a list of step objects — then replays one step per
// turn, wiring each step's visible inputs from its access_list via `sees`. After
// the last step it accepts. Recursion (Conductor naming itself) falls out: a step
// may target the conductor slot like any other.
//
// Pure TS: it needs only ctx.invoke (a model call), no weights and no Python. So
// it is fully testable by injecting an invoke that returns a canned plan.

import type { MonadObservation, MonadOutcome, MonadSlot } from "../../core/types.js";
import { extractJsonObject, registerRoutingPolicy, type RoutingPolicy, type RoutingPolicyContext } from "./registry.js";

interface PlannedStep {
  agentId: string;
  role: string;
  subtask: string;
  sees: number[];
}

interface ConductorConfig {
  /** Default role assigned to a planned step that doesn't name one. */
  defaultRole?: string;
}

function slotForAgent(slots: MonadSlot[], agentId: string): MonadSlot | undefined {
  return slots.find((slot) => slot.agentId === agentId);
}

function conductorPrompt(obs: MonadObservation, ctx: RoutingPolicyContext): string {
  const pool = ctx.slots.map((slot) => `  - "${slot.agentId}"${slot.label ? ` (${slot.label})` : ""}`).join("\n");
  return [
    `You are the Conductor. Decompose the request into a SEQUENTIAL workflow over the team, then stop.`,
    `Request:\n${obs.query}`,
    `Team (each step picks one):\n${pool}`,
    `Reply with ONLY a JSON object whose "steps" is an ordered list. Each step:`,
    `  {"agent":"<id>","role":"<role>","subtask":"<instruction>","sees":[<indices of earlier steps it may read>]}`,
    `Steps are numbered from 0 in order. A step's "sees" may reference only EARLIER step indices (its access_list). Keep it minimal — 2 to 5 steps.`,
    `Example: {"steps":[{"agent":"terry","role":"worker","subtask":"...","sees":[]},{"agent":"sidia","role":"verifier","subtask":"...","sees":[0]}]}`,
  ].join("\n\n");
}

/**
 * Parse a conductor reply into a validated, topologically-sound plan. Forward
 * references (a step seeing a later/own index) are dropped, matching the
 * sequential-with-selective-visibility execution model (not a free DAG).
 * Exported for unit testing.
 */
export function parseWorkflow(reply: string, ctx: RoutingPolicyContext, defaultRole: string): PlannedStep[] {
  const parsed = extractJsonObject(reply) as Record<string, unknown> | undefined;
  const rawSteps = parsed && Array.isArray(parsed.steps) ? parsed.steps : undefined;
  if (!rawSteps) return [];

  const plan: PlannedStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const agentId = typeof entry.agent === "string" ? entry.agent.replace(/^@/, "").trim() : "";
    const slot = slotForAgent(ctx.slots, agentId);
    if (!slot) continue; // unknown agent — skip
    const index = plan.length;
    const role = typeof entry.role === "string" && entry.role.trim() ? entry.role.trim() : slot.defaultRole ?? slot.label ?? defaultRole;
    const subtask = typeof entry.subtask === "string" && entry.subtask.trim() ? entry.subtask.trim() : `Step ${index}`;
    const sees = Array.isArray(entry.sees)
      ? entry.sees.filter((value): value is number => typeof value === "number" && value >= 0 && value < index)
      : [];
    plan.push({ agentId: slot.agentId, role, subtask, sees });
  }
  return plan;
}

class ConductorDagPolicy implements RoutingPolicy {
  readonly id = "conductor-dag";
  private plan: PlannedStep[] | undefined;
  constructor(private readonly config: ConductorConfig) {}

  async next(obs: MonadObservation, ctx: RoutingPolicyContext): Promise<MonadOutcome> {
    const defaultRole = this.config.defaultRole ?? "worker";

    // Plan once, on the first turn.
    if (this.plan === undefined) {
      let plan: PlannedStep[] = [];
      try {
        plan = parseWorkflow(await ctx.invoke(ctx.coordinatorAgentId, [{ role: "user", content: conductorPrompt(obs, ctx) }]), ctx, defaultRole);
      } catch {
        plan = [];
      }
      // Degrade gracefully: an unparseable plan becomes a single worker step.
      if (plan.length === 0) {
        const slot = ctx.slots.find((candidate) => candidate.defaultRole === "worker") ?? ctx.slots[0];
        if (slot) plan = [{ agentId: slot.agentId, role: "worker", subtask: obs.query, sees: [] }];
      }
      this.plan = plan;
    }

    const next = this.plan[obs.steps.length];
    if (!next) return { kind: "accept" };
    return { kind: "dispatch", decision: { agentId: next.agentId, role: next.role, subtask: next.subtask, sees: next.sees } };
  }
}

registerRoutingPolicy({
  id: "conductor-dag",
  ui: { label: "Conductor (DAG)", description: "A 7B-style conductor plans a sequential workflow with selective visibility (access_list), then replays it." },
  create: (config) => new ConductorDagPolicy((config ?? {}) as ConductorConfig),
});

export { ConductorDagPolicy };
