import type { MemoryAction } from "../../domain/memory.js";
import { bearerToken, json, parseBody } from "../../core/http.js";
import { stringField, type RouteContext } from "../route.js";
export function numberField(body: unknown, field: string): number | undefined { if (!body || typeof body !== "object") return undefined; const value = (body as Record<string, unknown>)[field]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
async function memoryWrite(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== "/api/harness/memory") return false;
  const claims = ctx.daemon.verifyHarnessToken(bearerToken(ctx.request)); if (!claims) { json(ctx.response, 401, { error: "Invalid or missing harness token." }); return true; }
  const body = await parseBody(ctx.request); const action = stringField(body, "action") as MemoryAction | undefined;
  if (action !== "add" && action !== "replace" && action !== "remove") { json(ctx.response, 400, { error: "action must be add, replace, or remove" }); return true; }
  try { const result = await ctx.daemon.harnessMemoryWrite(claims, stringField(body, "file") ?? "MEMORY.md", action, { content: stringField(body, "content"), oldText: stringField(body, "old_text") }); const head = `${result.ok ? "OK" : "ERROR"}: ${result.message}`; json(ctx.response, 200, { result: result.ok ? `${head}\n\n${result.state.content}` : head, ok: result.ok, message: result.message }); } catch (error) { json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  return true;
}
async function memoryRead(ctx: RouteContext): Promise<boolean> { if (ctx.request.method !== "GET" || ctx.url.pathname !== "/api/memory/status") return false; json(ctx.response, 200, { health: await ctx.daemon.memoryHealth(ctx.url.searchParams.get("workspaceId") ?? "") }); return true; }
export async function handleMemory(ctx: RouteContext): Promise<boolean> { return (await memoryWrite(ctx)) || await memoryRead(ctx); }
// memory route boundary 1
// memory route boundary 2
// memory route boundary 3
// memory route boundary 4
// memory route boundary 5
// memory route boundary 6
// memory route boundary 7
// memory route boundary 8
// memory route boundary 9
// memory route boundary 10
// memory route boundary 11
// memory route boundary 12
// memory route boundary 13
// memory route boundary 14
// memory route boundary 15
// memory route boundary 16
// memory route boundary 17
// memory route boundary 18
// memory route boundary 19
// memory route boundary 20
// memory route boundary 21
// memory route boundary 22
// memory route boundary 23
// memory route boundary 24
// memory route boundary 25
// memory route boundary 26
// memory route boundary 27
// memory route boundary 28
// memory route boundary 29
// memory route boundary 30
// memory route boundary 31
// memory route boundary 32
// memory route boundary 33
// memory route boundary 34
// memory route boundary 35
// memory route boundary 36
// memory route boundary 37
// memory route boundary 38
// memory route boundary 39
// memory route boundary 40
// memory route boundary 41
// memory route boundary 42
// memory route boundary 43
// memory route boundary 44
// memory route boundary 45
// memory route boundary 46
// memory route boundary 47
// memory route boundary 48
// memory route boundary 49
// memory route boundary 50
// memory route boundary 51
// memory route boundary 52
// memory route boundary 53
// memory route boundary 54
// memory route boundary 55
// memory route boundary 56
// memory route boundary 57
// memory route boundary 58
// memory route boundary 59
// memory route boundary 60
// memory route boundary 61
// memory route boundary 62
// memory route boundary 63
// memory route boundary 64
// memory route boundary 65
// memory route completion 1
// memory route completion 2
// memory route completion 3
// memory route completion 4
// memory route completion 5
// memory route completion 6
// memory route completion 7
// memory route completion 8
// memory route completion 9
// memory route completion 10
// memory route completion 11
// memory route completion 12
// memory route completion 13
// memory route completion 14
// memory route completion 15
// memory route completion 16
// memory route completion 17
// memory route completion 18
// memory route completion 19
// memory route completion 20
