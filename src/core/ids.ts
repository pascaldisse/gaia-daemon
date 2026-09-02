/**
 * Process-unique id with a readable prefix, e.g. "task_mbx1k2_a8f0q3xw".
 *
 * The `_<base36 ms>_<rand>` tail is load-bearing: the web transcript orders
 * messages by decoding the second-to-last segment as the mint time. A prefix may
 * contain underscores (`system_task_…`), but never mint an id without that tail.
 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Mint timestamp encoded in a newId() value; absent for legacy/non-minted ids. */
export function mintedAt(id: string, now = Date.now()): string | undefined {
  const segments = id.split("_");
  const mint = segments.length >= 3 ? segments.at(-2) ?? "" : "";
  const ms = /^[0-9a-z]+$/.test(mint) ? Number.parseInt(mint, 36) : Number.NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= now ? new Date(ms).toISOString() : undefined;
}
