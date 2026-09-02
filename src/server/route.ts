import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { cookieValue, json } from "../core/http.js";
import { verifySessionToken, type PublicUser } from "../domain/users.js";
import type { SummonCensusEntry } from "../services/summons.js";

/** Shared route parsing/response adapters; wire format remains core/http.ts. */
export function matchPath(path: string, pattern: RegExp): string[] | null {
  const result = path.match(pattern);
  return result ? result.slice(1).map((part) => decodeURIComponent(part ?? "")) : null;
}
export function errorJson(response: ServerResponse, status: number, error: unknown): void {
  json(response, status, { error: error instanceof Error ? error.message : String(error) });
}
export function requestingHuman(request: IncomingMessage): PublicUser | null {
  const token = cookieValue(request, "gaia_user");
  return token ? verifySessionToken(token) : null;
}
export function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}
export function boolField(body: unknown, field: string): boolean {
  return !!body && typeof body === "object" && (body as Record<string, unknown>)[field] === true;
}
export function numberField(body: unknown, field: string): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function stringArrayField(body: unknown, field: string): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>)[field];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : undefined;
}
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
export function summonCensusText(entries: SummonCensusEntry[]): string {
  if (entries.length === 0) return "No summon lanes found.";
  return entries.map((entry) => [entry.roomId, `@${entry.agentId}`, entry.state, `delivered:${entry.delivered}`, entry.resumeStatus ? `resume:${entry.resumeStatus}` : "", entry.lastEventAt ? `last:${entry.lastEventAt}` : "", entry.dirtyWorktree === undefined ? "" : entry.dirtyWorktree ? "dirty" : "clean"].filter(Boolean).join("  ")).join("\n");
}
export function titleCaseId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ") || id;
}
export function encodeSse(eventType: string, payload: unknown): string { return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`; }
export function beginSse(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
}
export function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function findAppBundleRoot(path: string): string | undefined {
  let dir = resolve(path);
  while (true) { if (dir.endsWith(".app")) return dir; const parent = dirname(dir); if (parent === dir) return undefined; dir = parent; }
}
export const AUTH_COOKIE = "gaia_user";
