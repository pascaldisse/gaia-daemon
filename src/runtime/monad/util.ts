// Small shared helpers used by the engine and the policies. Kept value-only and
// dependency-free so both layers can import without a cycle.

import type { ChatMessage, MonadObservation, MonadStep } from "./types.js";

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

/** Flatten chat messages into the single prompt string the runAgent path takes. */
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
