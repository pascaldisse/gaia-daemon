/** Edit/retry preserves absent-vs-empty attachment selections. */
export function stringArrayField(body: unknown, field: string): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>)[field];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : undefined;
}
