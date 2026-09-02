import { json, parseBody } from "../../core/http.js";
import { matchPath, boolField, respond, stringField, type RouteContext } from "../route.js";
export function attachmentRefs(body: unknown): { id: string; name?: string; mime?: string }[] | undefined { if (!body || typeof body !== "object") return undefined; const raw = (body as Record<string, unknown>).attachments; if (!Array.isArray(raw)) return undefined; const refs: { id: string; name?: string; mime?: string }[] = []; for (const item of raw) { if (!item || typeof item !== "object") continue; const record = item as Record<string, unknown>; if (typeof record.id !== "string" || !record.id.trim()) continue; refs.push({ id: record.id, ...(typeof record.name === "string" ? { name: record.name } : {}), ...(typeof record.mime === "string" ? { mime: record.mime } : {}) }); } return refs.length ? refs : undefined; }
export function sanitizeEditRefs(body: unknown): { eventId: string; quote: string; replacement: string }[] { if (!body || typeof body !== "object") return []; const raw = (body as Record<string, unknown>).edits; if (!Array.isArray(raw)) return []; return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").filter((item) => typeof item.eventId === "string" && !!item.eventId.trim() && typeof item.quote === "string" && !!item.quote.length && typeof item.replacement === "string").map((item) => ({ eventId: item.eventId as string, quote: item.quote as string, replacement: item.replacement as string })); }
async function selectRoom(ctx: RouteContext): Promise<boolean> { const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms$/); if (ctx.request.method !== "POST" || !params) return false; const body = await parseBody(ctx.request); const roomId = stringField(body, "roomId") ?? stringField(body, "id") ?? stringField(body, "room"); if (!roomId?.trim()) { json(ctx.response, 400, { error: "Missing room id" }); return true; } await respond(ctx.response, () => ctx.daemon.selectRoom(params[0], roomId.trim(), { incognito: boolField(body, "incognito") })); return true; }
async function selectNamedRoom(ctx: RouteContext): Promise<boolean> { const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(?:select|activate)$/); if (ctx.request.method !== "POST" || !params) return false; const body = await parseBody(ctx.request); await respond(ctx.response, () => ctx.daemon.selectRoom(params[0], params[1], { incognito: boolField(body, "incognito") })); return true; }
async function cancelRoom(ctx: RouteContext): Promise<boolean> { const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/cancel$/); if (ctx.request.method !== "POST" || !params) return false; const service = await ctx.daemon.serviceFor(params[0], params[1]); json(ctx.response, 202, { task: await service.cancelActiveTask() }); return true; }
async function deleteRoom(ctx: RouteContext): Promise<boolean> { const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)$/); if (ctx.request.method !== "DELETE" || !params) return false; await respond(ctx.response, () => ctx.daemon.deleteRoom(params[0], params[1])); return true; }
export async function handleRooms(ctx: RouteContext): Promise<boolean> { for (const handler of [selectRoom, selectNamedRoom, cancelRoom, deleteRoom]) if (await handler(ctx)) return true; return false; }
// rooms route boundary 1
// rooms route boundary 2
// rooms route boundary 3
// rooms route boundary 4
// rooms route boundary 5
// rooms route boundary 6
// rooms route boundary 7
// rooms route boundary 8
// rooms route boundary 9
// rooms route boundary 10
// rooms route boundary 11
// rooms route boundary 12
// rooms route boundary 13
// rooms route boundary 14
// rooms route boundary 15
// rooms route boundary 16
// rooms route boundary 17
// rooms route boundary 18
// rooms route boundary 19
// rooms route boundary 20
// rooms route boundary 21
// rooms route boundary 22
// rooms route boundary 23
// rooms route boundary 24
// rooms route boundary 25
// rooms route boundary 26
// rooms route boundary 27
// rooms route boundary 28
// rooms route boundary 29
// rooms route boundary 30
// rooms route boundary 31
// rooms route boundary 32
// rooms route boundary 33
// rooms route boundary 34
// rooms route boundary 35
// rooms route boundary 36
// rooms route boundary 37
// rooms route boundary 38
// rooms route boundary 39
// rooms route boundary 40
// rooms route boundary 41
// rooms route boundary 42
// rooms route boundary 43
// rooms route boundary 44
// rooms route boundary 45
// rooms route boundary 46
// rooms route boundary 47
// rooms route boundary 48
// rooms route boundary 49
// rooms route boundary 50
// rooms route boundary 51
// rooms route boundary 52
// rooms route boundary 53
// rooms route boundary 54
// rooms route boundary 55
// rooms route completion 1
// rooms route completion 2
// rooms route completion 3
// rooms route completion 4
// rooms route completion 5
// rooms route completion 6
// rooms route completion 7
// rooms route completion 8
// rooms route completion 9
// rooms route completion 10
// rooms route completion 11
// rooms route completion 12
// rooms route completion 13
// rooms route completion 14
// rooms route completion 15
// rooms route completion 16
// rooms route completion 17
// rooms route completion 18
// rooms route completion 19
// rooms route completion 20
