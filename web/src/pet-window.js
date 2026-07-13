import { api } from "./api.js";
import { PET_ANIMATIONS, petProgressView } from "./pet-state.js";

/** @typedef {import("./types.js").PetProgress} PetProgress */
/** @typedef {import("./pet-state.js").PetState} PetState */

const native = /** @type {any} */ (window).__TAURI__;
const root = requiredElement("#pet");
const sprite = requiredElement("#sprite");
const bubble = requiredElement("#bubble");
const params = new URLSearchParams(window.location.search);
const packageName = params.get("package") ?? "";
const agentId = params.get("agentId") ?? "";
let timer = 0;

if (!native) {
  root.replaceChildren();
  document.body.style.background = "#111";
  document.body.textContent = "Native desktop pets are unavailable in a browser.";
} else {
  installDrag();
  void loadPackage();
  void native.event.listen("gaia://pet-progress", (/** @type {{ payload: PetProgress }} */ event) => showProgress(event.payload));
}

/** @param {string} selector */
function requiredElement(selector) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`pet window mount is missing: ${selector}`);
  return element;
}

async function loadPackage() {
  try {
    /** @type {{ pet: { displayName: string, description: string, spritesheetUrl: string } }} */
    const body = await api(`/api/pet?name=${encodeURIComponent(packageName)}`);
    sprite.style.backgroundImage = `url(${JSON.stringify(body.pet.spritesheetUrl)})`;
    root.setAttribute("aria-label", `${body.pet.displayName}, bound to @${agentId}: ${body.pet.description}`);
    play("review");
  } catch {
    showProgress(/** @type {PetProgress} */ ({ status: "failed" }));
  }
}

/** @param {PetProgress} progress */
function showProgress(progress) {
  const view = petProgressView(progress);
  bubble.textContent = view.label;
  bubble.title = view.label;
  root.classList.toggle("failed", progress.status === "failed");
  play(view.state);
}

/** @param {PetState} requested */
function play(requested) {
  window.clearTimeout(timer);
  let state = requested;
  let frame = 0;
  let cycles = 0;
  const advance = () => {
    const animation = PET_ANIMATIONS[state];
    sprite.style.backgroundPosition = `${(frame / 7) * 100}% ${(animation.row / 8) * 100}%`;
    sprite.dataset.petState = state;
    sprite.dataset.petFrame = String(frame);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const duration = animation.timings[frame] * (state === "idle" ? 6 : 1);
    timer = window.setTimeout(() => {
      frame += 1;
      if (frame >= animation.timings.length) {
        frame = 0;
        if (state !== "idle" && ++cycles >= 3) state = "idle";
      }
      advance();
    }, duration);
  };
  advance();
}

function installDrag() {
  document.body.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    document.body.classList.add("dragging");
    void native.window.getCurrentWindow().startDragging();
  });
  window.addEventListener("pointerup", () => document.body.classList.remove("dragging"));
  window.addEventListener("blur", () => document.body.classList.remove("dragging"));
}
