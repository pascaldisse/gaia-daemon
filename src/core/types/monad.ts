// ---------------------------------------------------------------------------
// Monad vocabulary (embedded in state.json → core, not a layer above)

export interface ChatMessage {
  role: string;
  content: string;
}

export interface MonadSlot {
  index: number;
  agentId: string;
  label?: string;
  defaultRole?: string;
}

export interface MonadStep {
  index: number;
  agentId: string;
  role: string;
  subtask: string;
  reply: string;
  sees: number[] | "all";
}

export interface MonadObservation {
  query: string;
  /** Full incoming chat request, retained so workers can inspect original context. */
  messages: ChatMessage[];
  steps: MonadStep[];
}

export interface RouteDecision {
  agentId: string;
  role: string;
  subtask: string;
  sees: number[] | "all";
}

export type MonadOutcome = { kind: "dispatch"; decision: RouteDecision } | { kind: "accept" } | { kind: "stop"; reason: string };

export interface MonadConfig {
  policy: string;
  policyConfig?: unknown;
  slots: MonadSlot[];
  roles: string[];
  maxTurns: number;
  coordinatorAgentId?: string;
  /** Include the original chat request in every worker task. Defaults to true. */
  workerSeesRequest?: boolean;
  terminate?: { on: "verifier-accept"; acceptToken: string };
  /** Role prompt text inlined at setup activation — the room is self-contained. */
  rolePrompts?: Record<string, string>;
}

export interface MonadResult {
  final: string;
  steps: MonadStep[];
  terminatedBy: "accept" | "max-turns" | "stop";
}
