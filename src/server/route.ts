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

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  daemon: import("../daemon.js").Daemon;
  human: PublicUser | null;
  humanScope?: string;
  boundUrl: string;
  cwd: string;
  broadcast(event: import("../core/types.js").UiEvent): void;
  bootId: string;
  registerSse(workspaceId?: string, roomId?: string): void;
}
export async function respond(response: ServerResponse, run: () => Promise<unknown>): Promise<void> {
  try {
    json(response, 200, await run());
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
