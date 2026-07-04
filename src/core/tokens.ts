// A rough, dependency-free token estimate for pre-flight budgeting — used by the
// context-gate warning to decide, BEFORE a new agent runs, whether the transcript
// it would load is large enough to ask the human how much of it to give. ~4 chars
// per token is close enough for a threshold; the real count is reported by the
// harness once the turn runs (the context-usage event). Deliberately an estimate.

/** Approximate token count of `text` (~4 chars/token). Never negative. */
export function estimateTokens(text: string): number {
  const s = String(text ?? "");
  return s.length === 0 ? 0 : Math.ceil(s.length / 4);
}
