// "Your name" (Global Settings ▸ General): the label agents use for the human
// speaking in a room, replacing the anonymous "user" token that otherwise
// gets baked into every turn prompt's transcript (RoomEvent.author stays the
// literal "user" — this only changes the display label the transcript
// renders; see harness/prompt.ts renderRoomTranscript). Unset (empty string)
// keeps today's behavior: the default label ("user") lives in exactly one
// place, harness/prompt.ts, not here.
//
// Persistence follows the same shape as keep-awake.ts: a `userName` string
// living in ~/.gaia/app.json, read via readJson/writeJsonAtomic (core/store.ts).

import { globalPaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";

/** Read the configured name, trimmed. "" when unset. */
export async function readUserNameSetting(): Promise<string> {
  const config = ((await readJson(globalPaths.appSettings())) ?? {}) as { userName?: string };
  return typeof config.userName === "string" ? config.userName.trim() : "";
}

/** Persist the name, preserving whatever else lives in app.json (keepAwake,
 * recentWorkspaces) — read-merge-write, same as WorkspaceRegistry/keep-awake.
 * An empty/whitespace-only name clears the setting (back to unset). */
export async function writeUserNameSetting(name: string): Promise<void> {
  const config = ((await readJson(globalPaths.appSettings())) ?? {}) as Record<string, unknown>;
  const trimmed = name.trim();
  const next = { ...config };
  if (trimmed) next.userName = trimmed;
  else delete next.userName;
  await writeJsonAtomic(globalPaths.appSettings(), next);
}
