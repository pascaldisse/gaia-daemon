/** Agent-route display normalization. */
export function titleCaseId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ") || id;
}
