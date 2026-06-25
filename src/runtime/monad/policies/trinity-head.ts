// Fugu / TRINITY as a policy. The brain is a frozen Qwen3-0.6B + a tiny bias-free
// linear head on the penultimate hidden state (openfugu/mini.py's FuguRouter):
// each turn it reads the raw "role: content" transcript and emits (agent_id,
// role_id). That brain is torch/Python, so this TS policy shells out to a sidecar
// and maps its reply onto the pool. The RoutingPolicy seam is language-agnostic
// by design — the default policy needs no Python; this one does, and supplies it.
//
// The mapping (agent_id, role_id) -> RouteDecision is a pure function so it can be
// unit-tested without torch or weights. The sidecar/weights are fetched by the
// Fugu plugin (py/route.py + fetch_artifacts.py); absent them, next() throws a
// clear, actionable error rather than guessing.

import { spawn } from "node:child_process";
import { registerRoutingPolicy } from "../policy-registry.js";
import type { MonadObservation, MonadOutcome, MonadSlot, RouteDecision, RoutingPolicy, RoutingPolicyContext } from "../types.js";
import { lastStepWithRole, replyAccepts } from "../util.js";

interface TrinityConfig {
  /** Python interpreter (default "python3"). */
  python?: string;
  /** Path to the sidecar entry (the Fugu plugin's py/route.py). */
  script?: string;
  /** Path to the trained head weights (e.g. model_iter_60.npy). */
  weights?: string;
  /** Path/id of the frozen base model (Qwen3-0.6B). */
  baseModel?: string;
  /** Whether the head emits the 3 role logits (academic) or L-only (production). */
  roles?: "on" | "off";
}

/** The sidecar's stdout contract: one JSON line. */
interface RouterReply {
  agent_id?: number;
  role_id?: number;
  agent?: string;
  role?: string;
}

const ROLE_BY_ID = ["worker", "thinker", "verifier"] as const;

function slotByOrder(slots: MonadSlot[], agentIndex: number): MonadSlot | undefined {
  // TRINITY's worker index addresses the pool positionally (slot labels are
  // training metadata, remappable to any provider — same as Gaia's harnesses).
  return slots.find((slot) => slot.index === agentIndex) ?? slots[agentIndex];
}

/**
 * Map a sidecar reply onto a RouteDecision over the pool. Pure — no I/O. An
 * out-of-range agent index clamps to the pool; an out-of-range role id falls back
 * to the slot's default. Exported for unit tests.
 */
export function decisionFromRouter(reply: RouterReply, obs: MonadObservation, ctx: RoutingPolicyContext, rolesEnabled: boolean): RouteDecision | undefined {
  const slot =
    (typeof reply.agent === "string" ? ctx.slots.find((candidate) => candidate.agentId === reply.agent) : undefined) ??
    (typeof reply.agent_id === "number" ? slotByOrder(ctx.slots, reply.agent_id) : undefined);
  if (!slot) return undefined;

  let role: string;
  if (typeof reply.role === "string" && reply.role.trim()) role = reply.role.trim();
  else if (rolesEnabled && typeof reply.role_id === "number" && reply.role_id >= 0 && reply.role_id < ROLE_BY_ID.length) role = ROLE_BY_ID[reply.role_id];
  else role = slot.defaultRole ?? slot.label ?? "worker";

  const subtask =
    role === "verifier"
      ? `Check the latest result. Begin with ${ctx.terminate?.acceptToken ?? "ACCEPT"} or REVISE.`
      : role === "thinker"
        ? `Plan the next step for: "${obs.query}".`
        : `Continue the work toward answering: "${obs.query}".`;

  return { agentId: slot.agentId, role, subtask, sees: "all" };
}

function runSidecar(config: Required<Pick<TrinityConfig, "python" | "script">> & TrinityConfig, transcript: string): Promise<RouterReply> {
  return new Promise((resolve, reject) => {
    const args = [config.script, ...(config.weights ? ["--weights", config.weights] : []), ...(config.baseModel ? ["--base-model", config.baseModel] : []), ...(config.roles === "off" ? ["--no-roles"] : [])];
    const child = spawn(config.python, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => reject(new Error(`trinity-head: cannot launch sidecar (${config.python} ${config.script}): ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`trinity-head: sidecar exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      try {
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line) as RouterReply);
      } catch (error) {
        reject(new Error(`trinity-head: unparseable sidecar output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(transcript);
  });
}

class TrinityHeadPolicy implements RoutingPolicy {
  readonly id = "trinity-head";
  constructor(private readonly config: TrinityConfig) {}

  async next(obs: MonadObservation, ctx: RoutingPolicyContext): Promise<MonadOutcome> {
    // Verifier ACCEPT ends the loop (mini.py loops until ACCEPT or K turns).
    const acceptToken = ctx.terminate?.acceptToken ?? "ACCEPT";
    const lastVerifier = lastStepWithRole(obs, "verifier");
    if (lastVerifier && replyAccepts(lastVerifier.reply, acceptToken)) {
      const lastWorker = lastStepWithRole(obs, "worker");
      return { kind: "accept", finalStepIndex: lastWorker?.index ?? lastVerifier.index };
    }

    if (!this.config.script) {
      throw new Error("trinity-head: no sidecar configured. Set monad.policyConfig.script (the Fugu plugin's py/route.py) and .weights.");
    }
    const reply = await runSidecar({ python: this.config.python ?? "python3", script: this.config.script, weights: this.config.weights, baseModel: this.config.baseModel, roles: this.config.roles }, obs.transcript);
    const decision = decisionFromRouter(reply, obs, ctx, this.config.roles !== "off");
    if (!decision) return { kind: "stop", reason: "no-progress" };
    return { kind: "dispatch", decision };
  }
}

registerRoutingPolicy({
  id: "trinity-head",
  ui: { label: "TRINITY head", description: "A trained 0.6B + linear-head router (Fugu). Per-turn (agent, role) over a Python sidecar; needs weights." },
  create: (config) => new TrinityHeadPolicy((config ?? {}) as TrinityConfig),
});

export { TrinityHeadPolicy };
