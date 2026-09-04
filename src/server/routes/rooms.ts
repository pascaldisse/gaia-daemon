import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { ATTACHMENT_MAX_BYTES, attachmentMime } from "../../core/attachments.js";
import { json, parseBody, readRawBody } from "../../core/http.js";
import type { ReadAloudDelivery } from "../../services/read-aloud.js";
import { addArchtreeRoot } from "../../services/archtree.js";
import { matchPath, boolField, respond, requestingHuman, stringField, type RouteContext } from "../route.js";

export function attachmentRefs(body: unknown): { id: string; name?: string; mime?: string }[] | undefined { if (!body || typeof body !== "object") return undefined; const raw = (body as Record<string, unknown>).attachments; if (!Array.isArray(raw)) return undefined; const refs: { id: string; name?: string; mime?: string }[] = []; for (const item of raw) { if (!item || typeof item !== "object") continue; const record = item as Record<string, unknown>; if (typeof record.id !== "string" || !record.id.trim()) continue; refs.push({ id: record.id, ...(typeof record.name === "string" ? { name: record.name } : {}), ...(typeof record.mime === "string" ? { mime: record.mime } : {}) }); } return refs.length ? refs : undefined; }
function sanitizeEditRefs(body: unknown): { eventId: string; quote: string; replacement: string }[] { if (!body || typeof body !== "object") return []; const raw = (body as Record<string, unknown>).edits; if (!Array.isArray(raw)) return []; return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").filter((item) => typeof item.eventId === "string" && !!item.eventId.trim() && typeof item.quote === "string" && !!item.quote.length && typeof item.replacement === "string").map((item) => ({ eventId: item.eventId as string, quote: item.quote as string, replacement: item.replacement as string })); }

async function selectRoom(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const roomId = stringField(body, "roomId") ?? stringField(body, "id") ?? stringField(body, "room");
  if (!roomId?.trim()) { json(ctx.response, 400, { error: "Missing room id" }); return true; }
  await respond(ctx.response, () => ctx.daemon.selectRoom(params[0], roomId.trim(), { incognito: boolField(body, "incognito") }));
  return true;
}
async function selectNamedRoom(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(?:select|activate)$/);
  if (ctx.request.method !== "POST" || !params) return false;
  // The body is optional; when a room is being CREATED via select, it may
  // carry `incognito: true` (a no-op on an already-existing room).
  const incognito = boolField(await parseBody(ctx.request), "incognito");
  await respond(ctx.response, () => ctx.daemon.selectRoom(params[0], params[1], { incognito }));
  return true;
}
async function roomRole(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/role$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const agentId = stringField(body, "agentId");
  const role = stringField(body, "role");
  if (!agentId?.trim() || !role?.trim()) { json(ctx.response, 400, { error: "Missing agentId or role" }); return true; }
  await respond(ctx.response, () => ctx.daemon.setAgentRole(params[0], params[1], agentId.trim(), role.trim()));
  return true;
}
async function roomPlugin(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/plugins\/([A-Za-z0-9_-]+)$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const args = Array.isArray((body as { args?: unknown }).args)
    ? (body as { args: unknown[] }).args.filter((arg): arg is string => typeof arg === "string").slice(0, 16)
    : [];
  await respond(ctx.response, () => ctx.daemon.runPluginAction(params[0], params[1], params[2], args));
  return true;
}
async function roomAgentDialogue(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/agent-dialogue$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const on = (body as { on?: unknown }).on === true;
  await respond(ctx.response, () => ctx.daemon.setRoomAgentDialogue(params[0], params[1], on));
  return true;
}
async function roomTitle(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/title$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const title = stringField(body, "title")?.trim();
  if (!title) { json(ctx.response, 400, { error: "Missing room title" }); return true; }
  await respond(ctx.response, () => ctx.daemon.renameRoom(params[0], params[1], title));
  return true;
}
async function roomFavorite(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/favorite$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const favorite = ((await parseBody(ctx.request)) as { favorite?: unknown }).favorite === true;
  await respond(ctx.response, () => ctx.daemon.setRoomFavorite(params[0], params[1], favorite));
  return true;
}
// Sidebar drag-drop reorder of top-level rooms — same mechanic as
// /api/workspaces/reorder, room-scoped (see Daemon.reorderRooms). `ids` is the
// full desired top-level order for this workspace.
async function roomsReorder(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/reorder$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const raw = (await parseBody(ctx.request)) as { ids?: unknown };
  const ids = Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string") : [];
  await respond(ctx.response, () => ctx.daemon.reorderRooms(params[0], ids));
  return true;
}
// Room-level human membership (RoomState.humans). Absent/empty = today's
// unrestricted default for every existing room; a room only starts gating
// reads/posts (see the /messages and /events routes below) the moment it
// gets its first member. Every write here requires an authenticated human
// who is EITHER already a member OR the room has none yet (so someone can
// bootstrap membership on a room they otherwise already had full access to).
async function roomHumansGet(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/humans$/);
  if (ctx.request.method !== "GET" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  await respond(ctx.response, async () => ({ humans: await service.roomHumans() }));
  return true;
}
async function roomHumansPost(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/humans$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const requester = requestingHuman(ctx.request);
  if (!requester) { json(ctx.response, 401, { error: "Log in before managing room membership." }); return true; }
  const existing = await service.roomHumans();
  if (existing.length > 0 && !existing.includes(requester.id)) { json(ctx.response, 403, { error: "Not a member of this room." }); return true; }
  const body = await parseBody(ctx.request);
  const userId = stringField(body, "userId");
  if (!userId?.trim()) { json(ctx.response, 400, { error: "Missing userId" }); return true; }
  await respond(ctx.response, async () => ({ humans: await service.inviteHuman(userId.trim()) }));
  return true;
}
async function roomHumansDelete(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/humans\/([^/]+)$/);
  if (ctx.request.method !== "DELETE" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const requester = requestingHuman(ctx.request);
  if (!requester) { json(ctx.response, 401, { error: "Log in before managing room membership." }); return true; }
  const existing = await service.roomHumans();
  if (existing.length > 0 && !existing.includes(requester.id)) { json(ctx.response, 403, { error: "Not a member of this room." }); return true; }
  await respond(ctx.response, async () => ({ humans: await service.removeHuman(params[2]) }));
  return true;
}
// Attachment upload: the pasted file's bytes as the raw body, original
// filename in ?name=. Returns the server-issued id the client echoes back
// on the message send. Serving is GET on the same path + /<id>.
async function roomFileUpload(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/files$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const name = ctx.url.searchParams.get("name")?.trim() || "pasted-file";
  const contentType = ctx.request.headers["content-type"];
  const mime = typeof contentType === "string" && contentType !== "application/octet-stream" ? contentType.split(";")[0].trim() : undefined;
  try {
    const data = await readRawBody(ctx.request, ATTACHMENT_MAX_BYTES);
    if (data.length === 0) { json(ctx.response, 400, { error: "Empty file" }); return true; }
    const stored = await service.storeAttachment(name, data, mime);
    json(ctx.response, 201, { attachment: { id: stored.id, name: stored.name, mime: stored.mime, size: stored.size } });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
async function roomFileGet(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/files\/([^/]+)$/);
  if (ctx.request.method !== "GET" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const filePath = service.attachmentPath(params[2]);
  if (!existsSync(filePath) || !(await stat(filePath)).isFile()) { json(ctx.response, 404, { error: "Not found" }); return true; }
  // Ids are unique per upload, so the bytes are immutable — cache hard.
  ctx.response.writeHead(200, { "content-type": attachmentMime(params[2]), "cache-control": "max-age=31536000, immutable" });
  createReadStream(filePath).pipe(ctx.response);
  return true;
}
async function roomBackgroundTaskOutput(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/background-tasks\/([^/]+)\/output$/);
  if (ctx.request.method !== "GET" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const output = await service.backgroundTaskOutput(params[2]);
  if (output === undefined) { json(ctx.response, 404, { error: "Background task output not found" }); return true; }
  json(ctx.response, 200, { text: output.text, running: output.running });
  return true;
}
// Stop (SIGTERM its live writers) or dismiss a tracked background task —
// the tray's ■ stop / ✕ dismiss action. Harness-agnostic: liveness/stop
// live entirely in the shared room layer, no runtime is touched.
async function roomBackgroundTaskDelete(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/background-tasks\/([^/]+)$/);
  if (ctx.request.method !== "DELETE" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const stopped = await service.stopBackgroundTask(params[2]);
  if (!stopped) { json(ctx.response, 404, { error: "Background task not found" }); return true; }
  json(ctx.response, 200, { ok: true });
  return true;
}
async function roomMessages(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/messages$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const body = await parseBody(ctx.request);
  const textValue = stringField(body, "text") ?? "";
  const refs = attachmentRefs(body);
  // A picture with no words is a valid message; no words and no files is not.
  if (!textValue.trim() && !refs) { json(ctx.response, 400, { error: "Missing message text" }); return true; }
  let attachments;
  if (refs) {
    try {
      attachments = await service.resolveAttachments(refs);
    } catch (error) {
      json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  // queue:true is the Cmd/Ctrl+Enter opt-out of steer-by-default — force the
  // durable queue instead of injecting into the running turn.
  const queue = (body as { queue?: unknown }).queue === true;
  const human = requestingHuman(ctx.request);
  const membership = await service.roomHumans();
  if (membership.length > 0 && !membership.includes(human?.id ?? "")) { json(ctx.response, 403, { error: "Not a member of this room." }); return true; }
  const task = await service.sendMessage(textValue, {
    ...(attachments ? { attachments } : {}),
    ...(queue ? { queue } : {}),
    ...(human ? { human: { id: human.id, label: human.displayName } } : {}),
  });
  json(ctx.response, 202, { task });
  return true;
}
// Backwards paging through committed history ("load older" in the
// transcript): the events immediately before ?before=<eventId>.
async function roomEvents(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/events$/);
  if (ctx.request.method !== "GET" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const membership = await service.roomHumans();
  if (membership.length > 0 && !membership.includes(requestingHuman(ctx.request)?.id ?? "")) { json(ctx.response, 403, { error: "Not a member of this room." }); return true; }
  const before = ctx.url.searchParams.get("before")?.trim() || undefined;
  const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get("limit")) || 50));
  await respond(ctx.response, async () => service.eventsBefore(before, limit));
  return true;
}
// Thanks-Dario context sanitize. POST runs the reviewer persona and
// returns his proposal (slow — a real agent turn); GET returns the last
// saved proposal; POST /apply rewrites the approved events (originals
// preserved in redactions.jsonl) and resets sessions.
async function roomSanitize(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/sanitize$/);
  if (!params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  if (ctx.request.method === "GET") { await respond(ctx.response, async () => ({ proposal: await service.getSanitizeProposal() })); return true; }
  if (ctx.request.method === "POST") { await respond(ctx.response, async () => ({ proposal: await service.sanitizePreview() })); return true; }
  return false;
}
async function roomSanitizeApply(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/sanitize\/apply$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const body = await parseBody(ctx.request);
  const edits = sanitizeEditRefs(body);
  if (edits.length === 0) { json(ctx.response, 400, { error: "No edits provided" }); return true; }
  try {
    json(ctx.response, 200, await service.sanitizeApply(edits));
  } catch (error) {
    json(ctx.response, 409, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
async function roomSummons(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/summons$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const agentId = stringField(body, "agentId") ?? stringField(body, "agent");
  const taskText = stringField(body, "task");
  if (!agentId || !taskText?.trim()) { json(ctx.response, 400, { error: "Missing agentId or task" }); return true; }
  try {
    const coordinator = await ctx.daemon.coordinatorFor(params[0]);
    // UI-initiated: the human reads the result as a note in the parent room.
    const childRoomId = await coordinator.summon(params[1], agentId, taskText.trim(), { deliver: "note" });
    json(ctx.response, 202, { roomId: childRoomId });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
async function roomArchtreeRoot(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/archtree\/add-root$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const task = stringField(body, "task")?.trim();
  if (!task) { json(ctx.response, 400, { error: "Missing root task" }); return true; }
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const snapshot = await service.getSnapshot();
  const agentId = stringField(body, "agent")?.trim() || snapshot.room.activeAgent || snapshot.workspace.defaultAgent;
  try {
    const coordinator = await ctx.daemon.coordinatorFor(params[0]);
    const roomId = await addArchtreeRoot(coordinator, { parentRoomId: params[1], agentId, task });
    json(ctx.response, 202, { roomId });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
async function cancelRoom(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/cancel$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  json(ctx.response, 202, { task: await service.cancelActiveTask() });
  return true;
}
// Drop ONE durably-queued message (the ✕ on a queued ghost bubble). Queue
// ops live entirely in the shared room layer, so this is harness-agnostic —
// no runtime is touched. 404 when it already started running (can't unqueue
// a turn in flight).
async function roomQueueDelete(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/queue\/([^/]+)$/);
  if (ctx.request.method !== "DELETE" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const task = await service.deleteQueuedMessage(params[2]);
  if (!task) { json(ctx.response, 404, { error: "Queued message not found (it may have already started running)" }); return true; }
  json(ctx.response, 200, { task });
  return true;
}
// Reversible room delete: moves the room dir to trash and purges it from
// memory. Returns the neighbour room's snapshot (a room is always in view).
async function deleteRoom(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)$/);
  if (ctx.request.method !== "DELETE" || !params) return false;
  await respond(ctx.response, () => ctx.daemon.deleteRoom(params[0], params[1]));
  return true;
}
// Context gate: resolve a held new-agent first turn with the chosen amount
// of context — "full", "last" (+ n messages), or "compact".
async function roomContextGate(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/context-gate$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const choice = stringField(body, "choice");
  if (choice !== "full" && choice !== "last" && choice !== "compact") { json(ctx.response, 400, { error: "choice must be full | last | compact" }); return true; }
  const nRaw = body && typeof body === "object" ? (body as Record<string, unknown>).n : undefined;
  const n = typeof nRaw === "number" && Number.isInteger(nRaw) && nRaw > 0 ? nRaw : undefined;
  try {
    await ctx.daemon.resolveContextGate(params[0], params[1], choice, n);
    json(ctx.response, 200, { ok: true });
  } catch (error) {
    json(ctx.response, 502, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
// Read-aloud: one committed agent message → speech audio (the transcript
// play button), one chunk per request. The daemon resolves the author's
// engine+voice; this layer only streams the bytes. The x-tts-chunks
// header tells the client how many chunks to fetch/play in sequence.
async function roomReadAloud(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/read-aloud$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const eventId = stringField(body, "eventId");
  if (!eventId?.trim()) { json(ctx.response, 400, { error: "Missing eventId" }); return true; }
  const chunkRaw = body && typeof body === "object" ? (body as Record<string, unknown>).chunk : undefined;
  const chunk = typeof chunkRaw === "number" && Number.isInteger(chunkRaw) && chunkRaw >= 0 ? chunkRaw : 0;
  const regenerate = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).regenerate === true);
  try {
    const audio = await ctx.daemon.readAloud(params[0], params[1], eventId.trim(), chunk, regenerate);
    ctx.response.writeHead(200, {
      "content-type": audio.contentType,
      "content-length": audio.audio.length,
      "cache-control": "no-store",
      "x-tts-chunks": String(audio.chunks),
      "x-tts-chunk": String(audio.chunk),
    });
    ctx.response.end(audio.audio);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(
      ctx.response,
      message.startsWith("Unknown event") ? 404 : message.startsWith("Only agent") || message.startsWith("Nothing to read") || message.startsWith("Unknown chunk") ? 400 : 502,
      { error: message },
    );
  }
  return true;
}
// Read-aloud, streamed: the whole message as one continuous PCM pass, played
// frame-by-frame as it is generated (the claude.ai desktop-app path). The
// author's engine decides the mode — a batch-only engine answers "chunks",
// and the client keeps the per-chunk /read-aloud path above.
async function roomReadAloudStream(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/read-aloud\/stream$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const eventId = stringField(body, "eventId");
  if (!eventId?.trim()) { json(ctx.response, 400, { error: "Missing eventId" }); return true; }
  const regenerate = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).regenerate === true);
  let delivery: ReadAloudDelivery;
  try {
    delivery = await ctx.daemon.readAloudStream(params[0], params[1], eventId.trim(), regenerate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(
      ctx.response,
      message.startsWith("Unknown event") ? 404 : message.startsWith("Only agent") || message.startsWith("Nothing to read") ? 400 : 502,
      { error: message },
    );
    return true;
  }
  if (delivery.mode === "chunks") { json(ctx.response, 200, { mode: "chunks", chunks: delivery.chunks }); return true; }
  ctx.response.writeHead(200, {
    "content-type": "audio/pcm",
    "cache-control": "no-store",
    "x-tts-mode": "stream",
    "x-tts-rate": String(delivery.format.sampleRate),
    "x-tts-channels": String(delivery.format.channels),
    "x-tts-bits": String(delivery.format.bitsPerSample),
  });
  let clientGone = false;
  ctx.response.on("close", () => { clientGone = true; });
  try {
    for await (const frame of delivery.frames) {
      if (clientGone || ctx.response.writableEnded) break;
      if (!ctx.response.write(frame)) {
        await new Promise<void>((resolveWrite) => {
          const done = (): void => { ctx.response.off("drain", done); ctx.response.off("close", done); resolveWrite(); };
          ctx.response.once("drain", done);
          ctx.response.once("close", done);
        });
      }
    }
  } catch {
    // Mid-stream failure: headers are already sent, so just close.
  }
  if (!ctx.response.writableEnded) ctx.response.end();
  return true;
}

const roomHandlers = [
  selectRoom,
  selectNamedRoom,
  roomRole,
  roomPlugin,
  roomAgentDialogue,
  roomTitle,
  roomFavorite,
  roomHumansGet,
  roomHumansPost,
  roomHumansDelete,
  roomFileUpload,
  roomFileGet,
  roomsReorder,
  roomBackgroundTaskOutput,
  roomBackgroundTaskDelete,
  roomMessages,
  roomEvents,
  roomSanitize,
  roomSanitizeApply,
  roomSummons,
  roomArchtreeRoot,
  cancelRoom,
  roomQueueDelete,
  deleteRoom,
  roomContextGate,
  roomReadAloud,
  roomReadAloudStream,
];
export async function handleRooms(ctx: RouteContext): Promise<boolean> {
  for (const handler of roomHandlers) if (await handler(ctx)) return true;
  return false;
}
