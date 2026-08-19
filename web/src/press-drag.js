// Touch-vs-scroll arbitration for the pointer-drag reorders (tab strip,
// workspace list). ONE implementation, used by every draggable surface.
//
// Problem: those lists are the same surface the finger scrolls. With a plain
// 6px threshold every touch-scroll became a reorder (phone UI, 08-19).
// Rule: mouse/pen = drag arms on the movement threshold (unchanged).
//       touch      = drag arms only after a LONG PRESS that stays still;
//                    any earlier movement abandons the drag → native scroll.
// CSS keeps the scroll axis pannable (.tab pan-x / .ws-item pan-y) so the
// pre-arm gesture scrolls normally; once armed we swallow touchmove
// (non-passive) so the drag itself doesn't also scroll the list.

export const LONG_PRESS_MS = 420;
// Finger slop allowed during the long press before it's read as a scroll.
export const TOUCH_SLOP = 8;

/** @param {PointerEvent} event */
export const isTouchPointer = (event) => event.pointerType === "touch";

/** @type {((event: TouchEvent) => void)|null} */
let swallow = null;

/** Block native scrolling for the duration of an armed touch drag. */
export function holdTouchScroll() {
  if (swallow) return;
  swallow = (event) => event.preventDefault();
  document.addEventListener("touchmove", swallow, { passive: false });
}

export function releaseTouchScroll() {
  if (!swallow) return;
  document.removeEventListener("touchmove", swallow);
  swallow = null;
}

/** Short buzz when a touch drag arms, where the platform has one. */
export function hapticArm() {
  try {
    navigator.vibrate?.(12);
  } catch {
    // no vibration API — silent.
  }
}
