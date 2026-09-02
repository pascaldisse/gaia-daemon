/** Room-message route body adapters. Filesystem/service work stays in Daemon. */
export function attachmentRefs(body: unknown): { id: string; name?: string; mime?: string }[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return undefined;
  const refs: { id: string; name?: string; mime?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) continue;
    refs.push({ id: record.id, ...(typeof record.name === "string" ? { name: record.name } : {}), ...(typeof record.mime === "string" ? { mime: record.mime } : {}) });
  }
  return refs.length > 0 ? refs : undefined;
}
export function sanitizeEditRefs(body: unknown): { eventId: string; quote: string; replacement: string }[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as Record<string, unknown>).edits;
  if (!Array.isArray(raw)) return [];
  const edits: { eventId: string; quote: string; replacement: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.eventId !== "string" || !record.eventId.trim() || typeof record.quote !== "string" || record.quote.length === 0 || typeof record.replacement !== "string") continue;
    edits.push({ eventId: record.eventId, quote: record.quote, replacement: record.replacement });
  }
  return edits;
}
