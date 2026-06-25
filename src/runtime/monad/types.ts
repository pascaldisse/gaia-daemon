// Shared monad data types. Value-free (like runtime/capabilities.ts) so the
// engine (app layer), the policies (runtime layer), and room state can all
// import these without an import cycle: nothing here depends on app/ or room/.
//
// One vocabulary covers BOTH Fugu variants:
//   - TRINITY  : a per-turn router — decide one step from the evolving state.
//   - Conductor: a workflow planner — plan a DAG on turn 0, replay one step/turn,
//                wiring each step's visible inputs via `sees` (the access_list).

/** A chat message a policy may feed to its routing model via ctx.invoke. */
export interface ChatMessage {
  role: string;
  content: string;
}

/** A worker slot in the pool: which gaia agent runs, and its default role. */
export interface MonadSlot {
  index: number;
  agentId: string;
  /** Human label (Fugu's training metadata: "thinker"/"worker"/…); UI only. */
  label?: string;
  /** Role this slot conditions on when a policy picks it without naming one. */
  defaultRole?: string;
}

/** A completed step in the loop — one summoned worker's contribution. */
export interface MonadStep {
  index: number;
  /** Resolved gaia agent that ran this step. */
  agentId: string;
  /** Role it acted as: "thinker" | "worker" | "verifier" | … */
  role: string;
  /** The natural-language instruction this step was given. */
  subtask: string;
  /** Indices of earlier steps fed into this one (the Conductor access_list). */
  sees: number[];
  /** The worker's output. */
  reply: string;
}

/** Everything a policy observes about the run so far. */
export interface MonadObservation {
  /** The original user query. */
  query: string;
  /** Completed steps, in execution order. */
  steps: MonadStep[];
  /** Raw "role: content" rendering — TRINITY's decisive input format. */
  transcript: string;
}

/** A policy's instruction to run one more worker step. */
export interface RouteDecision {
  /** Worker to dispatch (must be one of the pool's slot agents). */
  agentId: string;
  /** Role to condition the worker on. */
  role: string;
  /** Natural-language instruction for this step. */
  subtask: string;
  /** Which prior outputs this step may see ("all", or explicit indices). */
  sees: number[] | "all";
}

/** What the engine should do next, as decided by the policy. */
export type MonadOutcome =
  | { kind: "dispatch"; decision: RouteDecision }
  | { kind: "accept"; finalStepIndex?: number }
  | { kind: "stop"; reason: "max-turns" | "no-progress" };

/** Read-only view the engine hands a policy on every `next()` call. */
export interface RoutingPolicyContext {
  slots: MonadSlot[];
  roles: string[];
  maxTurns: number;
  /** Agent the policy should route its model calls through (for invoke). */
  coordinatorAgentId: string;
  /** Termination convenience the engine honors (verifier ACCEPT token). */
  terminate?: { on: "verifier-accept"; acceptToken: string };
  /**
   * Thin model-call handle a policy may use. The prompt-driven and Conductor
   * policies call a model here; the head policy shells out to a python sidecar
   * instead and ignores this. Implemented by the engine over its `dispatch` /
   * `invoke` functions.
   */
  invoke(agentId: string, messages: ChatMessage[]): Promise<string>;
}

/** The brain: decides the next action from the evolving observation. */
export interface RoutingPolicy {
  id: string;
  next(obs: MonadObservation, ctx: RoutingPolicyContext): Promise<MonadOutcome>;
}

/** Registry descriptor — one per policy id (mirrors HarnessSpec). */
export interface RoutingPolicySpec {
  id: string;
  ui?: { label: string; description: string };
  /** Build a policy instance from the setup's `monad.policyConfig`. */
  create(config: unknown): RoutingPolicy;
}

/**
 * The active-monad configuration carried on a room (RoomState.monad) and read
 * by the engine. Written by setup activation; present ⇒ the room is a monad
 * room and plain user messages route through MonadEngine.
 */
export interface MonadConfig {
  /** Routing policy id (must be registered). */
  policy: string;
  /** Opaque per-policy config, passed to RoutingPolicySpec.create. */
  policyConfig?: unknown;
  /** The worker pool. */
  slots: MonadSlot[];
  /** Roles in play, in default-cycle order. */
  roles: string[];
  /** Hard ceiling on dispatched steps. */
  maxTurns: number;
  /** Agent used for routing model calls; defaults to slots[0].agentId. */
  coordinatorAgentId?: string;
  /** Verifier-accept termination convenience honored by the engine. */
  terminate?: { on: "verifier-accept"; acceptToken: string };
  /**
   * Role prompts inlined at activation (role name → markdown body). Lets the
   * engine assemble a worker's task without live role-file resolution, so a
   * monad room is self-contained in its state.
   */
  rolePrompts?: Record<string, string>;
}

/** What the engine returns when a run settles. */
export interface MonadResult {
  /** The single answer to surface to the user ("answer as one"). */
  final: string;
  /** Every step, for inspection / the step trace. */
  steps: MonadStep[];
  /** How the loop ended: "verifier-accept" | "accept" | "max-turns" | … */
  terminatedBy: string;
}
