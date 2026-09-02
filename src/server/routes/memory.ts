/** Memory/tool paging accepts finite numeric request fields only. */
export function numberField(body: unknown, field: string): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
