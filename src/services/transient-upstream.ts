/** Retry budget for no-output failures from a transient provider/upstream. */
export const TURN_TRANSIENT_RETRIES = 3;
/** Delay before each retry; the final value applies if the retry budget grows. */
export const TURN_TRANSIENT_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

/** Uniform runtime-channel classifier; permanent provider responses never retry. */
export function isTransientUpstreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    /\b(?:401|403|400)\b|invalid_request|authentication|unauthori[sz]ed|forbidden|\b(?:safety|tos|terms of service)\b|context[ _-]?(?:length|window)|circuit[ _-]?breaker(?:[ _-]?open)?/.test(normalized)
  ) return false;
  if (/overloaded_error|\b(?:econnreset|etimedout|econnrefused|socket hang up)\b|upstream[ _-]stall(?:[ _-](?:timeout|error))?|\b(?:upstream|request|gateway|connection)[ _-]?timeout\b/.test(normalized)) return true;
  if (/\b(?:529|503|502)\b/.test(normalized)) return true;
  if (/\b429\b[\s\S]*rate_limit_error|rate_limit_error[\s\S]*\b429\b/.test(normalized)) return true;
  return /\b500\b[\s\S]*api_error|api_error[\s\S]*\b500\b/.test(normalized);
}

export function transientRetryOptions(): { retries: number; backoffMs: readonly number[] } {
  return { retries: TURN_TRANSIENT_RETRIES, backoffMs: TURN_TRANSIENT_BACKOFF_MS };
}

/** Wait on the task's existing cancellation state; no second cancel channel. */
export async function waitForTransientRetry(delayMs: number, isCancelled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + delayMs;
  while (!isCancelled()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 50)));
  }
  return false;
}
