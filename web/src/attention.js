// attention.js — the "an agent finished while you weren't looking" signal:
// a dock badge (the red number) plus an OS notification, mirroring the ping
// Claude Code / Codex give you when a turn completes.
//
// Everything is derived from state the client already has: the per-room unread
// marks (state.js), fed by the workspace-scoped `rooms` SSE event the daemon
// broadcasts on every turn commit. So there is NO daemon or harness change — a
// turn finishing is already surfaced uniformly for every harness. The native
// shell drives the real dock badge + Notification Center via the Tauri bridge
// (native.js); a plain browser degrades to the tab title and the web
// Notification API, so the web build stays a working backup.

import { installNativeFocusTracking, isNative, isMainWindow, nativeNotify, setDockBadge } from "./native.js";
import { reloadReadMarks, roomPending, state, syncReadMarks } from "./state.js";

/** @typedef {import("./types.js").RoomSummary} RoomSummary */

/** Room ids that were pending on the previous pass, so we act on the RISING edge
 * only (a room that JUST started needing attention), not on every recompute.
 * Seeded on the priming pass with the pre-existing backlog so that neither the
 * badge nor a notification announces activity from before the app was open. */
const known = new Set();
/** Rooms that crossed into pending DURING this session (a turn that finished
 * while the app was running) and haven't been read yet — this, not the whole
 * unread backlog, is what the dock badge counts, matching Claude Code / Codex.
 * A room leaves as soon as it stops being pending (you opened/read it). */
const counted = new Set();
/** False until the priming pass has captured the backlog; set true there. */
let primed = false;
/** The tab title with no badge prefix, captured once (browser fallback). */
let baseTitle = "";

/** Rooms in the open workspace awaiting attention (see state.roomPending). */
function pendingRooms() {
  return (state.snapshot?.rooms ?? []).filter((room) => roomPending(room));
}

/**
 * Recompute pending rooms → update the dock badge and fire a notification for
 * any room that just became pending. Only the main window drives this: the dock
 * badge is application-global, so extra/torn windows would only fight over it.
 * Call after every snapshot / rooms / room-event update, and on focus changes.
 */
export function refreshAttention() {
  if (!isMainWindow()) return;
  const pending = pendingRooms();
  const ids = new Set(pending.map((room) => room.id));

  // Priming pass: everything already pending is pre-launch backlog. Record it as
  // known (so it never notifies) but do NOT count it — the badge starts at 0 and
  // only rises for turns that finish while the app is open.
  if (!primed) {
    primed = true;
    for (const id of ids) known.add(id);
    setBadge(0);
    return;
  }

  // Rising edge: a room that just became pending is a turn that finished this
  // session → count it toward the badge and notify.
  for (const room of pending) {
    if (!known.has(room.id)) {
      counted.add(room.id);
      notifyDone(room);
    }
  }
  // A counted room that is no longer pending was read (you opened it, focused) —
  // drop it so the badge falls as you catch up, just like Claude Code / Codex.
  for (const id of [...counted]) {
    if (!ids.has(id)) counted.delete(id);
  }

  setBadge(counted.size);

  known.clear();
  for (const id of ids) known.add(id);
}

/** @param {number} count */
function setBadge(count) {
  if (isNative()) {
    void setDockBadge(count);
    return;
  }
  // Browser: the tab title carries the badge.
  if (typeof document === "undefined") return;
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}

/** @param {RoomSummary} room */
function notifyDone(room) {
  const title = room.title ?? room.id;
  const body = "An agent finished replying.";
  if (isNative()) {
    void nativeNotify({ title, body });
    return;
  }
  postWebNotification(title, body);
}

/** Best-effort web notification (browser backup). No-op unless permission was
 * granted (requested once on the first gesture, see installAttention). */
function postWebNotification(/** @type {string} */ title, /** @type {string} */ body) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(title, { body });
  } catch {
    // A few browsers throw on the direct Notification constructor; ignore.
  }
}

/**
 * Install the attention lifecycle: keep the badge fresh as focus/visibility
 * change (looking back at the window reads the open room and clears its share of
 * the badge), pick up read marks another window advanced, and — in a browser —
 * ask for notification permission once on the first user gesture.
 */
export function installAttention() {
  if (typeof window === "undefined") return;
  baseTitle = document.title || "GAIA";

  const onRefocus = () => {
    // Regaining focus reads the open room; recompute so its badge clears.
    syncReadMarks();
    refreshAttention();
  };
  window.addEventListener("focus", onRefocus);
  document.addEventListener("visibilitychange", onRefocus);
  // In the native shell, browser focus/visibility events don't fire when the
  // window merely stops being frontmost, so drive the same recompute off the
  // shell's real window focus/blur events (see native.js).
  void installNativeFocusTracking(onRefocus);

  // Another GAIA window advanced the shared read marks (localStorage); the main
  // window that owns the badge would not otherwise notice a room was read there.
  window.addEventListener("storage", (event) => {
    if (event.key && event.key !== "gaia.readMarks" && event.key !== "gaia.manualUnread") return;
    reloadReadMarks();
    refreshAttention();
  });

  // Browser backup: request notification permission on the first gesture (most
  // browsers reject an unprompted request). Native uses the OS prompt instead.
  if (!isNative() && typeof Notification !== "undefined" && Notification.permission === "default") {
    const ask = () => void Notification.requestPermission().catch(() => {});
    window.addEventListener("pointerdown", ask, { once: true });
  }
}
