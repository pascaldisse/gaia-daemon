import type { MemoryAction } from "../../domain/memory.js";
import { json, parseBody } from "../../core/http.js";
import { authorizeHarnessCall, matchPath, stringField, type RouteContext } from "../route.js";

export function numberField(body: unknown, field: string): number | undefined { if (!body || typeof body !== "object") return undefined; const value = (body as Record<string, unknown>)[field]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

// GET /api/workspaces/:id/memory/status — human/UI-scoped (workspace
// ownership already gated upstream), distinct from the harness-token-scoped
// /api/harness/memory write path below.
async function memoryStatus(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/memory\/status$/);
  if (ctx.request.method !== "GET" || !params) return false;
  json(ctx.response, 200, { health: await ctx.daemon.memoryHealth(params[0]) });
  return true;
}
// POST /api/harness/memory — the daemon-side half of the `gaia mem` verb.
// Batch mode (§5): operations validate together against the FINAL budget and
// commit atomically — one write, all-or-nothing. Simple mode: a single
// add/replace/remove action.
async function memoryWrite(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== "/api/harness/memory") return false;
  const authorized = await authorizeHarnessCall(ctx, "memory");
  if (!authorized) return true;
  const { claims } = authorized;
  const body = await parseBody(ctx.request);
  const rawOps = (body as Record<string, unknown>).operations;
  if (Array.isArray(rawOps)) {
    const operations = rawOps
      .filter((op): op is Record<string, unknown> => !!op && typeof op === "object")
      .filter((op) => op.action === "add" || op.action === "replace" || op.action === "remove")
      .map((op) => ({
        action: op.action as MemoryAction,
        ...(typeof op.content === "string" ? { content: op.content } : {}),
        ...(typeof op.old_text === "string" ? { oldText: op.old_text } : typeof op.oldText === "string" ? { oldText: op.oldText } : {}),
      }));
    if (!operations.length) { json(ctx.response, 400, { error: "operations must be a non-empty array of {action, content?, old_text?}" }); return true; }
    try {
      const result = await ctx.daemon.harnessMemoryBatch(claims, stringField(body, "file") ?? "MEMORY.md", operations);
      const head = `${result.ok ? "OK" : "ERROR"}: ${result.message}`;
      json(ctx.response, 200, { result: result.ok ? `${head}\n\n${result.state.content}` : head, ok: result.ok, message: result.message });
    } catch (error) {
      json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const action = stringField(body, "action") as MemoryAction | undefined;
  if (action !== "add" && action !== "replace" && action !== "remove") {
    json(ctx.response, 400, { error: "action must be add, replace, or remove" });
    return true;
  }
  try {
    const result = await ctx.daemon.harnessMemoryWrite(claims, stringField(body, "file") ?? "MEMORY.md", action, {
      content: stringField(body, "content"),
      oldText: stringField(body, "old_text"),
    });
    const head = `${result.ok ? "OK" : "ERROR"}: ${result.message}`;
    json(ctx.response, 200, { result: result.ok ? `${head}\n\n${result.state.content}` : head, ok: result.ok, message: result.message });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

const memoryHandlers = [memoryStatus, memoryWrite];
export async function handleMemory(ctx: RouteContext): Promise<boolean> {
  for (const handler of memoryHandlers) if (await handler(ctx)) return true;
  return false;
}
