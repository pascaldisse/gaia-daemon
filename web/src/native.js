// native.js — the Tauri shell bridge.
//
// Every export here is a safe no-op in a plain browser, so the web build stays a
// fully working backup: native windows, the native menu, and cross-window events
// only come alive when the GAIA shell (Tauri) is hosting this UI. Nothing in here
// touches the daemon or the web-serving contract — the shell just loads the same
// http://127.0.0.1:<port>/ a browser would, and these helpers drive the OS window
// around it.

/** The global Tauri API surface (present only under the shell). @returns {any} */
function T() {
  return /** @type {any} */ (typeof window !== "undefined" ? window : {}).__TAURI__;
}

/** Running inside the Tauri shell rather than a plain browser tab? */
export function isNative() {
  return typeof window !== "undefined" && Boolean(T());
}

/** This window's Tauri label: "main" for the primary window, "win-N" otherwise. */
export function currentLabel() {
  if (!isNative()) return "main";
  try {
    return String(T().window.getCurrentWindow().label);
  } catch {
    return "main";
  }
}

/** The primary window owns the canonical tab set and is the redock target. */
export function isMainWindow() {
  return currentLabel() === "main";
}

/**
 * Invoke a Rust command. Resolves undefined (and logs) in a browser or on error,
 * so callers never have to guard twice.
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 */
export async function invoke(cmd, args) {
  if (!isNative()) return undefined;
  try {
    return await T().core.invoke(cmd, args);
  } catch (err) {
    console.error(`[native] invoke ${cmd} failed`, err);
    return undefined;
  }
}

/**
 * Open a native GAIA window pointed at the same daemon UI.
 * @param {{ mode: "new"|"torn", room?: string|null, x?: number|null, y?: number|null }} opts
 */
export async function openWindow({ mode, room = null, x = null, y = null }) {
  return invoke("open_window", { mode, room, x, y });
}

/** Merge this (torn) window's chat back into the main window; the shell then
 *  closes this window. No-op in the main window / a browser.
 *  @param {string} room */
export async function redockCurrent(room) {
  return invoke("redock", { room });
}

/** Close the current native window. */
export async function closeCurrentWindow() {
  if (!isNative()) return;
  try {
    await T().window.getCurrentWindow().close();
  } catch (err) {
    console.error("[native] close window failed", err);
  }
}

/**
 * Parse the launch hash the shell attaches to spawned windows:
 *   #gaia?mode=torn&room=<id>   — a torn-off chat (start with panels collapsed)
 *   #gaia?mode=new              — a fresh full window
 * Absent/!native → the primary window's default view.
 * @returns {{ mode: "main"|"torn"|"new", room: string|null }}
 */
export function launchIntent() {
  const hash = (typeof window !== "undefined" && window.location.hash) || "";
  const m = hash.match(/^#gaia\?(.*)$/);
  if (!m) return { mode: "main", room: null };
  const p = new URLSearchParams(m[1]);
  const raw = p.get("mode");
  const mode = raw === "torn" ? "torn" : raw === "new" ? "new" : "main";
  return { mode, room: p.get("room") };
}

/**
 * Subscribe to a cross-window / native-menu event. Returns an unlisten function
 * (a no-op in a browser).
 * @param {string} name
 * @param {(event: { payload: unknown }) => void} handler
 * @returns {Promise<() => void>}
 */
export async function onNativeEvent(name, handler) {
  if (!isNative()) return () => {};
  try {
    return await T().event.listen(name, handler);
  } catch (err) {
    console.error(`[native] listen ${name} failed`, err);
    return () => {};
  }
}
