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
