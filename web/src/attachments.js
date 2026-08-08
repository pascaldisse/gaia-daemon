// Tiny shared helper for committed (already-uploaded) message attachments.
// Split out so both transcript.js (rendering a sent message) and
// composer.js (rendering an in-progress edit of one) can use it without an
// import cycle between the two.
import { state } from "./state.js";

/** @typedef {import("./types.js").MessageAttachment} MessageAttachment */

/**
 * Serve URL for a committed attachment: the on-disk id (path basename) under
 * the current room's files route.
 * @param {MessageAttachment} file
 */
export function attachmentUrl(file) {
  const snapshot = state.snapshot;
  if (!snapshot) return "#";
  const id = file.path.split("/").pop() ?? "";
  return `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/files/${encodeURIComponent(id)}`;
}
