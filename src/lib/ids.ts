/** Process-unique id with a readable prefix, e.g. "task_mbx1k2_a8f0q3xw". */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
