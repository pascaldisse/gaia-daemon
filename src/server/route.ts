import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { bearerToken, cookieValue, json } from "../core/http.js";
import { verifySessionToken, type PublicUser } from "../domain/users.js";
import type { SummonCensusEntry } from "../services/summons.js";
import type { HarnessTokenClaims } from "../services/bridge.js";
import type { Workspace } from "../core/types.js";
import type { GaiaTool } from "../harness/spec.js";

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

/** Shared /api/harness/<verb> preamble: bearer-token → claims, claims →
 * workspace, then the GaiaTool grant gate for that verb (tool-result-fetch/
 * context-diet/end-conversation gate on the unified "gaia" grant; dream/dog/
 * tools carve out of the grant check entirely — mirrors handleHarness).
 * One implementation, called by every /api/harness/* domain route module so
 * the gate can never drift between them. Responds + returns undefined on
 * any failure (401/404/403); callers must check the return value. */
export async function authorizeHarnessCall(
  ctx: RouteContext,
  verb: string,
): Promise<{ claims: HarnessTokenClaims; workspace: Workspace } | undefined> {
  const claims = ctx.daemon.verifyHarnessToken(bearerToken(ctx.request));
  if (!claims) { json(ctx.response, 401, { error: "Invalid or missing harness token." }); return undefined; }
  let workspace: Workspace;
  try {
    workspace = (await ctx.daemon.serviceFor(claims.workspaceId, claims.roomId)).workspace;
  } catch (error) {
    json(ctx.response, 404, { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
  if (verb !== "dream" && verb !== "dog" && verb !== "tools") {
    const gaiaToolGate: GaiaTool = verb === "tool-result-fetch" || verb === "context-diet" || verb === "end-conversation" ? "gaia" : (verb as GaiaTool);
    if (!ctx.daemon.harnessGaiaTools(workspace, claims.agentId).includes(gaiaToolGate)) {
      json(ctx.response, 403, { error: `This agent's harness does not grant the ${gaiaToolGate} tool.` });
      return undefined;
    }
  }
  return { claims, workspace };
}
