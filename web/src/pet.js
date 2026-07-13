import { api } from "./api.js";
import { h } from "./dom.js";
import { PET_ANIMATIONS, statusToPetState } from "./pet-state.js";

/** @typedef {import("./pet-state.js").PetState} PetState */
/** @typedef {import("./pet-state.js").PetActivity} PetActivity */
/** @typedef {{ id: string, displayName: string, description: string, spritesheetPath: string, spritesheetUrl: string }} PetPayload */
/** @typedef {{ x: number, y: number }} PetPosition */

export const DEFAULT_PET_NAME = "gaia";
const ENABLED_KEY = "gaia.pet.enabled";
const NAME_KEY = "gaia.pet.name";
const POSITION_KEY = "gaia.pet.position";
const EDGE_MARGIN = 16;
const DRAG_DIRECTION_THRESHOLD = 12;

/** @type {HTMLElement|null} */
let overlay = null;
/** @type {HTMLElement|null} */
let sprite = null;
/** @type {ReturnType<typeof createAnimator>|null} */
let animator = null;
/** @type {PetState} */
let activityState = "idle";
/** @type {MediaQueryList|null} */
let reducedMotion = null;
let loadSequence = 0;

/** @param {string} [defaultName] */
export function petName(defaultName = DEFAULT_PET_NAME) {
  try {
    return localStorage.getItem(NAME_KEY)?.trim() || defaultName;
  } catch {
    return defaultName;
  }
}

export function petEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

/** @param {boolean} enabled */
export function setPetEnabled(enabled) {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {
    // Storage disabled — apply it for this page only.
  }
  if (!overlay) return;
  overlay.hidden = !enabled;
  if (enabled) void loadSelectedPet();
  else animator?.stop();
}

/** @param {string} name */
export function setPetName(name) {
  const selected = name.trim() || DEFAULT_PET_NAME;
  try {
    localStorage.setItem(NAME_KEY, selected);
  } catch {
    // Storage disabled — the package changes for this page only.
  }
  void loadSelectedPet(selected);
}

/** Map a daemon/UI activity through the pure reducer and start that sequence. @param {PetActivity|null|undefined} activity */
export function setPetActivity(activity) {
  activityState = statusToPetState(activity);
  animator?.play(activityState);
}

/** Mount once into the app's pet overlay slot. @param {string} [defaultName] */
export function installPet(defaultName = DEFAULT_PET_NAME) {
  const slot = document.querySelector("#overlay-pet");
  if (!(slot instanceof HTMLElement) || overlay) return;

  sprite = h("div", { class: "gaia-pet-sprite", "aria-hidden": "true" });
  overlay = h("div", {
    class: "gaia-pet-overlay",
    role: "img",
    tabindex: "0",
    "aria-label": "GAIA pet",
    title: "Drag pet to a corner",
  }, sprite);
  overlay.hidden = !petEnabled();
  slot.replaceChildren(overlay);

  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  animator = createAnimator(sprite, () => reducedMotion?.matches === true);
  reducedMotion.addEventListener("change", () => animator?.play(activityState));
  installPetInteraction(overlay);
  restorePosition(overlay);
  window.addEventListener("resize", () => {
    if (overlay) snapToCorner(overlay, false);
  });

  // Codex's first-awake notification takes precedence on initial load.
  activityState = statusToPetState({ kind: "first-awake" });
  if (petEnabled()) void loadSelectedPet(petName(defaultName));
}

/** @param {HTMLElement} element @param {() => boolean} isReduced */
function createAnimator(element, isReduced) {
  /** @type {number|undefined} */
  let timer;
  /** @type {PetState} */
  let current = "idle";

  /** @param {PetState} state @param {number} column */
  const paint = (state, column) => {
    const row = PET_ANIMATIONS[state].row;
    element.style.backgroundPosition = `${(column / 7) * 100}% ${(row / 8) * 100}%`;
    element.dataset.petState = state;
    element.dataset.petFrame = String(column);
  };

  /** @param {PetState} requested */
  const play = (requested) => {
    if (timer !== undefined) window.clearTimeout(timer);
    current = requested;
    let frame = 0;
    let cycles = 0;

    const advance = () => {
      const animation = PET_ANIMATIONS[current];
      paint(current, frame);
      if (isReduced()) return;
      const duration = animation.timings[frame] * (current === "idle" ? 6 : 1);
      timer = window.setTimeout(() => {
        frame += 1;
        if (frame >= animation.timings.length) {
          frame = 0;
          if (current !== "idle") {
            cycles += 1;
            if (cycles >= 3) {
              current = "idle";
              cycles = 0;
            }
          }
        }
        advance();
      }, duration);
    };
    advance();
  };

  const stop = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  return { play, stop };
}

/** @param {string} [selectedName] */
async function loadSelectedPet(selectedName = petName()) {
  if (!overlay || !sprite || !petEnabled()) return;
  const sequence = ++loadSequence;
  overlay.dataset.error = "";
  try {
    /** @type {{ pet: PetPayload }} */
    const body = await api(`/api/pet?name=${encodeURIComponent(selectedName)}`);
    if (sequence !== loadSequence || !overlay || !sprite) return;
    sprite.style.backgroundImage = `url(${JSON.stringify(body.pet.spritesheetUrl)})`;
    overlay.setAttribute("aria-label", `${body.pet.displayName}: ${body.pet.description}`);
    overlay.title = `${body.pet.displayName} — drag to a corner`;
    animator?.play(activityState);
  } catch (error) {
    if (sequence !== loadSequence || !overlay) return;
    const message = error instanceof Error ? error.message : String(error);
    overlay.dataset.error = message;
    overlay.title = `Pet unavailable: ${message}`;
  }
}

/** @param {HTMLElement} element */
function installPetInteraction(element) {
  /** @type {{ pointerId: number, startX: number, startY: number, x: number, y: number, direction: PetState|null }|null} */
  let drag = null;

  element.addEventListener("pointerenter", () => {
    if (!drag) animator?.play("jumping");
  });
  element.addEventListener("pointerleave", () => {
    if (!drag) animator?.play(activityState);
  });
  element.addEventListener("pointerdown", (rawEvent) => {
    const event = /** @type {PointerEvent} */ (rawEvent);
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = element.getBoundingClientRect();
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, direction: null };
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
  });
  element.addEventListener("pointermove", (rawEvent) => {
    const event = /** @type {PointerEvent} */ (rawEvent);
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    place(element, drag.x + dx, drag.y + dy);
    const direction = dx >= DRAG_DIRECTION_THRESHOLD ? "running-right" : dx <= -DRAG_DIRECTION_THRESHOLD ? "running-left" : drag.direction;
    if (direction && direction !== drag.direction) {
      drag.direction = direction;
      animator?.play(direction);
    }
  });
  const finish = (/** @type {Event} */ rawEvent) => {
    const event = /** @type {PointerEvent} */ (rawEvent);
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    element.classList.remove("dragging");
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    snapToCorner(element, true);
    animator?.play(activityState);
  };
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
}

/** @param {HTMLElement} element */
function restorePosition(element) {
  /** @type {PetPosition|null} */
  let saved = null;
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) saved = parsed;
  } catch {
    // Missing/corrupt storage falls back to the bottom-right corner.
  }
  requestAnimationFrame(() => {
    if (saved) place(element, saved.x, saved.y);
    else place(element, window.innerWidth - element.offsetWidth - EDGE_MARGIN, window.innerHeight - element.offsetHeight - EDGE_MARGIN);
    snapToCorner(element, false);
  });
}

/** @param {HTMLElement} element @param {boolean} persist */
function snapToCorner(element, persist) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2 < window.innerWidth / 2 ? EDGE_MARGIN : window.innerWidth - rect.width - EDGE_MARGIN;
  const y = rect.top + rect.height / 2 < window.innerHeight / 2 ? EDGE_MARGIN : window.innerHeight - rect.height - EDGE_MARGIN;
  place(element, x, y);
  if (!persist) return;
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ x: Math.max(0, x), y: Math.max(0, y) }));
  } catch {
    // Storage disabled — snapping still works for this page.
  }
}

/** @param {HTMLElement} element @param {number} x @param {number} y */
function place(element, x, y) {
  const maxX = Math.max(0, window.innerWidth - element.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - element.offsetHeight);
  element.style.left = `${Math.max(0, Math.min(maxX, x))}px`;
  element.style.top = `${Math.max(0, Math.min(maxY, y))}px`;
}
