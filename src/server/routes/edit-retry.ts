import { json, parseBody } from "../../core/http.js";
import { matchPath, stringField, type RouteContext } from "../route.js";
export function stringArrayField(body: unknown, field: string): string[] | undefined { if (!body || typeof body !== "object") return undefined; const raw = (body as Record<string, unknown>)[field]; return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : undefined; }
async function editOrRetry(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(retry|edit)$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]); const body = await parseBody(ctx.request); const eventId = stringField(body, "eventId"); const text = stringField(body, "text"); const keepAttachmentPaths = stringArrayField(body, "keepAttachments");
  if (!eventId?.trim()) { json(ctx.response, 400, { error: "Missing eventId" }); return true; }
  if (params[2] === "edit" && !text?.trim()) { json(ctx.response, 400, { error: "Missing message text" }); return true; }
  try { const task = params[2] === "edit" ? await service.editMessage(eventId.trim(), text!, keepAttachmentPaths) : await service.retryMessage(eventId.trim()); json(ctx.response, 202, { task }); } catch (error) { json(ctx.response, 409, { error: error instanceof Error ? error.message : String(error) }); }
  return true;
}
export async function handleEditRetry(ctx: RouteContext): Promise<boolean> { return editOrRetry(ctx); }
// edit-retry route boundary 1
// edit-retry route boundary 2
// edit-retry route boundary 3
// edit-retry route boundary 4
// edit-retry route boundary 5
// edit-retry route boundary 6
// edit-retry route boundary 7
// edit-retry route boundary 8
// edit-retry route boundary 9
// edit-retry route boundary 10
// edit-retry route boundary 11
// edit-retry route boundary 12
// edit-retry route boundary 13
// edit-retry route boundary 14
// edit-retry route boundary 15
// edit-retry route boundary 16
// edit-retry route boundary 17
// edit-retry route boundary 18
// edit-retry route boundary 19
// edit-retry route boundary 20
// edit-retry route boundary 21
// edit-retry route boundary 22
// edit-retry route boundary 23
// edit-retry route boundary 24
// edit-retry route boundary 25
// edit-retry route boundary 26
// edit-retry route boundary 27
// edit-retry route boundary 28
// edit-retry route boundary 29
// edit-retry route boundary 30
// edit-retry route boundary 31
// edit-retry route boundary 32
// edit-retry route boundary 33
// edit-retry route boundary 34
// edit-retry route boundary 35
// edit-retry route boundary 36
// edit-retry route boundary 37
// edit-retry route boundary 38
// edit-retry route boundary 39
// edit-retry route boundary 40
// edit-retry route boundary 41
// edit-retry route boundary 42
// edit-retry route boundary 43
// edit-retry route boundary 44
// edit-retry route boundary 45
// edit-retry route boundary 46
// edit-retry route boundary 47
// edit-retry route boundary 48
// edit-retry route boundary 49
// edit-retry route boundary 50
// edit-retry route boundary 51
// edit-retry route boundary 52
// edit-retry route boundary 53
// edit-retry route boundary 54
// edit-retry route boundary 55
// edit-retry route boundary 56
// edit-retry route boundary 57
// edit-retry route boundary 58
// edit-retry route boundary 59
// edit-retry route boundary 60
// edit-retry route boundary 61
// edit-retry route boundary 62
// edit-retry route boundary 63
// edit-retry route boundary 64
// edit-retry route boundary 65
// edit-retry route boundary 66
// edit-retry route boundary 67
// edit-retry route boundary 68
// edit-retry route boundary 69
// edit-retry route boundary 70
