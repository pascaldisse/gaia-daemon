// The routing-policy seam. One descriptor per policy: a policy is added by
// dropping in one `policies/<x>.ts` that calls `registerRoutingPolicy(...)` at
// its bottom and adding one import to the barrel (`policies/index.ts`). Nothing
// else learns a policy id — the engine, the setup loader, and the config
// parsers iterate this registry generically, never `=== "trinity-head"`.
// This is the exact shape of the harness registry, on purpose: routing policy
// is to the monad engine what a harness is to the runtime seam.
//
// The monad vocabulary (MonadSlot/Step/Observation/Outcome/…) lives in
// core/types.ts; this module adds only the policy-spec surface plus the small
// value-only helpers shared by the engine and the policies.

import type { ChatMessage, MonadConfig, MonadObservation, MonadOutcome, MonadSlot, MonadStep } from "../../core/types.js";

// --- policy-spec surface ------------------------------------------------------

/** Read-only view the engine hands a policy on every `next()` call. */
export interface RoutingPolicyContext {
  slots: MonadSlot[];
  roles: string[];
  maxTurns: number;
  /** Agent the policy should route its model calls through (for invoke). */
  coordinatorAgentId: string;
  /** Termination convenience the engine honors (verifier ACCEPT token). */
  terminate?: MonadConfig["terminate"];
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

// --- registry -------------------------------------------------------------------

const registry = new Map<string, RoutingPolicySpec>();

/** Self-registration entry point: each `policies/<x>.ts` calls this at its bottom. */
export function registerRoutingPolicy(spec: RoutingPolicySpec): void {
  registry.set(spec.id, spec);
}

export function routingPolicyIds(): string[] {
  return [...registry.keys()];
}

/** Strict lookup used by the engine: throws for an unknown policy. */
export function routingPolicySpecFor(id: string): RoutingPolicySpec {
  const spec = registry.get(id);
  if (!spec) throw new Error(`Unsupported routing policy: ${id}`);
  return spec;
}

/** The single policy parser: a value is a policy iff it is a registered id. */
export function parseRoutingPolicy(raw: unknown): string | undefined {
  return typeof raw === "string" && registry.has(raw) ? raw : undefined;
}

// --- shared helpers (value-only, dependency-free) --------------------------------

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a verifier reply ACCEPT? The Verifier role is told to begin its reply
 * with the accept token (default "ACCEPT") or "REVISE". Match the token as the
 * leading word, case-insensitively, tolerating surrounding markdown/whitespace.
 */
export function replyAccepts(reply: string, token: string): boolean {
  const cleaned = reply.replace(/^[\s*_#>`-]+/, "");
  return new RegExp(`^${escapeRegExp(token)}\\b`, "i").test(cleaned);
}

/** Render the loop so far as the raw "role: content" transcript TRINITY needs. */
export function renderTranscript(query: string, steps: MonadStep[]): string {
  return [`user: ${query}`, ...steps.map((step) => `${step.role}: ${step.reply.trim()}`)].join("\n\n");
}

/** Flatten chat messages into the single prompt string the dispatch path takes. */
export function renderMessages(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}

/**
 * Extract the first balanced top-level JSON object from a model reply, tolerating
 * code fences and surrounding prose. Returns the parsed value or undefined.
 * Policies that ask a model for a JSON decision use this instead of a brittle
 * JSON.parse on the whole reply.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** The most recent step with the given role, or undefined. */
export function lastStepWithRole(obs: MonadObservation, role: string): MonadStep | undefined {
  for (let i = obs.steps.length - 1; i >= 0; i--) {
    if (obs.steps[i].role === role) return obs.steps[i];
  }
  return undefined;
}
