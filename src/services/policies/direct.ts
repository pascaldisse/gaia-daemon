import type { MonadObservation, MonadOutcome } from "../../core/types.js";
import { registerRoutingPolicy, type RoutingPolicy, type RoutingPolicyContext } from "./registry.js";

class DirectPolicy implements RoutingPolicy {
  readonly id = "direct";

  async next(obs: MonadObservation, ctx: RoutingPolicyContext): Promise<MonadOutcome> {
    if (obs.steps.length > 0) return { kind: "accept" };
    const slot = ctx.slots[0];
    if (!slot) return { kind: "stop", reason: "no worker slot" };
    return {
      kind: "dispatch",
      decision: {
        agentId: slot.agentId,
        role: slot.defaultRole ?? slot.label ?? "worker",
        subtask: "Answer the user's request directly and completely.",
        sees: [],
      },
    };
  }
}

registerRoutingPolicy({
  id: "direct",
  ui: { label: "Direct", description: "Dispatch the only worker once without a coordinator round." },
  create: () => new DirectPolicy(),
});
