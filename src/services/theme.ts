// UI theme (Global Settings ▸ General · theme palette). v2 parity: the chosen
// palette is a DAEMON setting, not a browser one — every client (app window,
// pet window, a phone on the LAN) opens on the same theme, and a cleared
// browser store no longer loses it. The client still writes localStorage, but
// only as a pre-paint cache so there is no flash of the default palette.
//
// Persistence follows keep-awake.ts / user-name.ts exactly: a `theme` string
// in ~/.gaia/app.json, read-merge-write via readJson/writeJsonAtomic.
// Validation of the id lives ONCE, client-side (web/src/themes.js), because
// the palettes themselves only exist there — the daemon stores an opaque
// string and never renders it.

import { globalPaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";

/** Read the persisted theme id. "" when unset (client falls back to its own
 * default). */
export async function readThemeSetting(): Promise<string> {
  const config = ((await readJson(globalPaths.appSettings())) ?? {}) as { theme?: string };
  return typeof config.theme === "string" ? config.theme.trim() : "";
}

/** Persist the theme id, preserving everything else in app.json. An empty id
 * clears the setting back to unset. */
export async function writeThemeSetting(theme: string): Promise<void> {
  const config = ((await readJson(globalPaths.appSettings())) ?? {}) as Record<string, unknown>;
  const trimmed = theme.trim();
  const next = { ...config };
  if (trimmed) next.theme = trimmed;
  else delete next.theme;
  await writeJsonAtomic(globalPaths.appSettings(), next);
}
