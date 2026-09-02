// Browser-side budget must outlive the daemon STT request budget (120s) so
// the daemon, rather than an early client abort, reports provider failures.
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 125_000;

/** @param {number} [timeoutMs] @returns {number} */
export function transcriptionTimeoutMs(timeoutMs = DEFAULT_TRANSCRIBE_TIMEOUT_MS) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}
