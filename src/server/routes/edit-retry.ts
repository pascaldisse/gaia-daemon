import { json, parseBody } from "../../core/http.js";
import { matchPath, stringField, type RouteContext } from "../route.js";

export function stringArrayField(body: unknown, field: string): string[] | undefined { if (!body || typeof body !== "object") return undefined; const raw = (body as Record<string, unknown>)[field]; return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : undefined; }

// Fork-from-message: retry regenerates the reply produced by a user
// message; edit re-sends it with new text. Both truncate the transcript
// at that message (dropped events preserved in rewound.jsonl).
async function editOrRetry(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(retry|edit)$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const service = await ctx.daemon.serviceFor(params[0], params[1]);
  const body = await parseBody(ctx.request);
  const eventId = stringField(body, "eventId");
  const text = stringField(body, "text");
  // Which of the original message's own attachments (by path) survive the
  // edit. Absent => keep all (unchanged behavior); present (even []) =>
  // narrow to that set. Never lets the client attach a NEW path.
  const keepAttachmentPaths = stringArrayField(body, "keepAttachments");
  if (!eventId?.trim()) { json(ctx.response, 400, { error: "Missing eventId" }); return true; }
  if (params[2] === "edit" && !text?.trim()) { json(ctx.response, 400, { error: "Missing message text" }); return true; }
  try {
    const task = params[2] === "edit"
      ? await service.editMessage(eventId.trim(), text!, keepAttachmentPaths)
      : await service.retryMessage(eventId.trim());
    json(ctx.response, 202, { task });
  } catch (error) {
    json(ctx.response, 409, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

export async function handleEditRetry(ctx: RouteContext): Promise<boolean> {
  return editOrRetry(ctx);
}
