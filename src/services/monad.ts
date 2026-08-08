// The monad loop: route → dispatch a worker → append → repeat until a policy
// ACCEPTs, the verifier accepts, or maxTurns. The genuinely new logic over
// summons is (1) routing as a swappable policy and (2) step data-threading
// (assembleTask wires each step's visible inputs). Everything else is summons:
// `dispatch` is `SummonHost.summonAndWait`, so every step is a real, inspectable
// child room ("see underneath" for free).
//
// The engine depends on TWO injected functions, not on the daemon directly, so
// it is trivially testable:
//   dispatch(agentId, task) -> the worker's reply  (production: a visible summon)
//   invoke(agentId, prompt) -> a model reply        (routing calls; defaults to dispatch)

import type { ChatMessage, MonadConfig, MonadObservation, MonadResult, MonadStep, RouteDecision } from "../core/types.js";
import { renderMessages, replyAccepts, routingPolicySpecFor, type RoutingPolicy, type RoutingPolicyContext } from "./policies/registry.js";

export interface MonadEngineOptions {
  config: MonadConfig;
  /** The room the steps summon from (their parent in the rooms tree). */
  parentRoomId: string;
  /** Run a visible worker step; returns its reply. Production: summonAndWait. */
  dispatch: (agentId: string, task: string) => Promise<string>;
  /** Run a routing model call; returns its reply. Defaults to `dispatch`. */
  invoke?: (agentId: string, prompt: string) => Promise<string>;
  /**
   * Resolve a role's prompt body for an agent. Used only as a fallback when the
   * config did not inline the role prompt (config.rolePrompts). Defaults to "".
   */
  resolveRolePrompt?: (agentId: string, role: string) => Promise<string>;
  /** Pre-resolved policy (tests inject one); otherwise resolved from the registry. */
  policy?: RoutingPolicy;
}

export interface MonadRunOptions {
  isCancelled?: () => boolean;
  /** Called as each step settles (for live step traces). */
  onStep?: (step: MonadStep) => void;
}

export class MonadEngine {
  private readonly config: MonadConfig;

  constructor(private readonly options: MonadEngineOptions) {
    this.config = options.config;
  }

  async run(query: string, runOptions: MonadRunOptions = {}): Promise<MonadResult> {
    const isCancelled = runOptions.isCancelled ?? (() => false);
    const policy = this.options.policy ?? routingPolicySpecFor(this.config.policy).create(this.config.policyConfig);
    const obs: MonadObservation = { query, steps: [] };

    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      if (isCancelled()) return this.finalize(obs, "stop");

      const outcome = await policy.next(obs, this.context());
      if (outcome.kind === "accept") return this.finalize(obs, "accept");
      if (outcome.kind === "stop") return this.finalize(obs, "stop");

      const decision = outcome.decision;
      const task = await this.assembleTask(decision, obs);
      const reply = await this.options.dispatch(decision.agentId, task);

      const step: MonadStep = {
        index: turn,
        agentId: decision.agentId,
        role: decision.role,
        subtask: decision.subtask,
        sees: decision.sees === "all" ? obs.steps.map((prev) => prev.index) : decision.sees,
        reply,
      };
      obs.steps.push(step);
      runOptions.onStep?.(step);

      // Engine-level termination convenience: a verifier ACCEPT ends the loop in
      // the same turn it is produced, so the policy needn't burn another turn to
      // notice. The answer is the last worker step, not the verifier's "ACCEPT".
      if (this.config.terminate?.on === "verifier-accept" && step.role === "verifier" && replyAccepts(reply, this.config.terminate.acceptToken)) {
        return this.finalize(obs, "accept");
      }
    }

    return this.finalize(obs, "max-turns");
  }

  // Build the worker's prompt from its role + the prior outputs it may see. This
  // is the Conductor access_list made concrete: a step sees exactly `decision.sees`.
  private async assembleTask(decision: RouteDecision, obs: MonadObservation): Promise<string> {
    const rolePrompt = await this.rolePromptFor(decision.agentId, decision.role);
    const sees = decision.sees;
    const seen = sees === "all" ? obs.steps : obs.steps.filter((step) => sees.includes(step.index));
    const context = seen
      .map((step) => `<step ${step.index} · ${step.role} (@${step.agentId})>\n${step.reply.trim()}\n</step ${step.index}>`)
      .join("\n\n");
    return [rolePrompt.trim(), context && `Context from earlier steps:\n${context}`, `Your task: ${decision.subtask}`]
      .filter(Boolean)
      .join("\n\n");
  }

  private async rolePromptFor(agentId: string, role: string): Promise<string> {
    const inlined = this.config.rolePrompts?.[role];
    if (inlined && inlined.trim()) return inlined;
    if (this.options.resolveRolePrompt) return (await this.options.resolveRolePrompt(agentId, role)) ?? "";
    return "";
  }

  private context(): RoutingPolicyContext {
    const run = this.options.invoke ?? this.options.dispatch;
    return {
      slots: this.config.slots,
      roles: this.config.roles,
      maxTurns: this.config.maxTurns,
      coordinatorAgentId: this.config.coordinatorAgentId ?? this.config.slots[0]?.agentId ?? "",
      terminate: this.config.terminate,
      invoke: (agentId: string, messages: ChatMessage[]) => run(agentId, renderMessages(messages)),
    };
  }

  private lastWorkerIndex(obs: MonadObservation): number | undefined {
    for (let i = obs.steps.length - 1; i >= 0; i--) {
      if (obs.steps[i].role === "worker") return obs.steps[i].index;
    }
    return undefined;
  }

  // The final answer is the last worker step; failing that, the last step of any
  // role (a verifier-only pool still answers something rather than nothing).
  private finalize(obs: MonadObservation, terminatedBy: MonadResult["terminatedBy"]): MonadResult {
    const index = this.lastWorkerIndex(obs) ?? (obs.steps.length > 0 ? obs.steps[obs.steps.length - 1].index : -1);
    const step = obs.steps.find((candidate) => candidate.index === index);
    return { final: step?.reply ?? "", steps: obs.steps, terminatedBy };
  }
}
