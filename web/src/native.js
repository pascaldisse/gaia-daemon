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

// Whether the native window is the active (key) window. `document.hasFocus()` is
// unreliable in a background WKWebView — it keeps returning true even when the
// GAIA app isn't frontmost — so the shell's real focus/blur events are the only
// trustworthy signal for "is the user actually looking at this window". Starts
// true (the shell opens focused); the first blur corrects it. Browser code never
// reads this (it uses document.hasFocus()).
let nativeFocused = true;

/** The native window's current focus state (always true off-shell). */
export function isNativeWindowFocused() {
  return nativeFocused;
}

/**
 * Track the native window's focus via Tauri's window focus/blur events (which
 * DO fire correctly, unlike document.hasFocus in a background WKWebView). No-op
 * in a browser. `onChange(focused)` runs on every transition so callers can
 * re-read the open room / refresh the badge.
 * @param {(focused: boolean) => void} [onChange]
 */
export async function installNativeFocusTracking(onChange) {
  if (!isNative()) return;
  try {
    await T().window.getCurrentWindow().onFocusChanged((/** @type {{ payload: unknown }} */ event) => {
      nativeFocused = Boolean(event.payload);
      if (onChange) onChange(nativeFocused);
    });
  } catch (err) {
    console.error("[native] focus tracking failed", err);
  }
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

/**
 * Set the app's dock badge (the "N unread" red number). Native-only: in a plain
 * browser this is a no-op (the caller falls back to the tab title). `count <= 0`
 * clears the badge.
 * @param {number} count
 */
export async function setDockBadge(count) {
  return invoke("set_badge", { count: Math.max(0, Math.round(count)) });
}

/**
 * Post a native OS notification. Native-only (the browser backup uses the web
 * Notification API instead). Best-effort — resolves undefined off-shell.
 * @param {{ title: string, body: string }} opts
 */
export async function nativeNotify({ title, body }) {
  return invoke("notify", { title, body });
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
