// The archtree view: a full-surface 3D overlay showing the daemon's live room
// hierarchy as a tree. Self-contained on purpose — the only couplings to the
// rest of the client are three existing, generic seams:
//   state.snapshot.rooms  (data, the very same list the sidebar tree reads)
//   selectRoom()          (navigation, the very same call the sidebar makes)
//   one sidebar button     (entry point)
// No room/summon logic is touched, no server route is added, no npm dep.
//
// Live updates need no subscription: the render loop reads the current
// snapshot every frame, so a lane starting, finishing or withering shows up as
// soon as the client's state does. The loop exists ONLY while the view is
// open (close -> dispose -> no WebGL context, no rAF).

import { selectRoom } from "../actions.js";
import { api } from "../api.js";
import { $, h } from "./../dom.js";
import { state } from "../state.js";
import { buildModel } from "./model.js";
import { layoutTree } from "./layout.js";
import { resolveParams } from "./params.js";
import { createRenderer } from "./port.js";
import "./renderer.js"; // registers the "webgl2" port

/** @typedef {import("./params.js").ArchtreeParams} ArchtreeParams */

/** @type {{ root: HTMLElement, canvas: HTMLCanvasElement, hud: HTMLElement, port: import("./port.js").RendererPort, params: ArchtreeParams, raf: number, last: number, hover: string|null } | null} */
let live = null;

/** Is the archtree view currently open? @returns {boolean} */
export function archtreeOpen() {
  return live !== null;
}

/** localStorage key holding a JSON override object for ArchtreeParams. */
export const PARAMS_STORAGE_KEY = "gaia.archtree.params";

/**
 * Visual magnitudes stay overridable without a code change: a JSON object under
 * PARAMS_STORAGE_KEY patches the defaults (unknown/badly-typed keys are ignored
 * by resolveParams). Unreadable storage = defaults, never a throw.
 * @returns {ArchtreeParams}
 */
function currentParams() {
  try {
    const raw = globalThis.localStorage?.getItem(PARAMS_STORAGE_KEY);
    return resolveParams(raw ? JSON.parse(raw) : null);
  } catch {
    return resolveParams(null);
  }
}

/** @returns {import("./model.js").ArchtreeRoom[]} */
function currentRooms() {
  return /** @type {import("./model.js").ArchtreeRoom[]} */ (state.snapshot?.rooms ?? []);
}

/** @param {string|null} id */
function hudText(id) {
  if (!id) return "drag = orbit · wheel = zoom · click = open room · esc = close";
  const room = currentRooms().find((entry) => entry.id === id);
  if (!room) return "";
  const model = buildModel(currentRooms(), { params: currentParams() });
  const node = model.nodes.find((entry) => entry.id === id);
  const age = room.lastActivity ? `${Math.round((Date.now() - room.lastActivity) / 60000)} min ago` : "never";
  return `${node?.label ?? room.id} · ${node?.status ?? "?"} · depth ${node?.depth ?? 0} · ${node?.descendants ?? 0} descendants · last ${age}`;
}

/** Open the room a node stands for — the same navigation the sidebar performs. */
/** @param {string} roomId */
async function jumpToRoom(roomId) {
  const workspaceId = state.snapshot?.workspace?.id;
  if (!workspaceId) return;
  closeArchtree();
  await selectRoom(workspaceId, roomId);
}

/** Prompt for an orthogonal root task and create it under this view's room. */
async function addRootFromArchtree() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const task = window.prompt("New archtree root task");
  if (!task?.trim()) return;
  const agent = snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent;
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/archtree/add-root`, {
      method: "POST",
      body: JSON.stringify({ agent, task: task.trim() }),
    });
  } catch (error) {
    reportUnavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Last open failure, kept readable for the UI/tests. @type {string|null} */
export let archtreeError = null;

/**
 * A failed open is reported loudly (console + exported reason) instead of
 * leaving a mute, dead overlay on screen.
 * @param {string} message
 */
function reportUnavailable(message) {
  archtreeError = message;
  console.error(`archtree unavailable: ${message}`);
}

export function closeArchtree() {
  if (!live) return;
  cancelAnimationFrame(live.raf);
  live.port.dispose();
  live.root.remove();
  live = null;
}

export function openArchtree() {
  if (live) {
    closeArchtree();
    return;
  }
  const app = $("#app");
  if (!app) return;
  const params = currentParams();

  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "archtree-canvas" }));
  const hud = h("div", { class: "archtree-hud", text: hudText(null) });
  const root = h(
    "div",
    { class: "archtree-view" },
    canvas,
    h(
      "div",
      { class: "archtree-chrome" },
      h("span", { class: "archtree-title", text: "陽 ・ archtree ・ 陰" }),
      h("button", { class: "archtree-add-root", title: "create a root lane under this coordinator", onclick: () => void addRootFromArchtree(), text: "+ root" }),
      h("button", { class: "archtree-close", title: "close (esc)", onclick: () => closeArchtree(), text: "✕" }),
    ),
    hud,
  );
  app.appendChild(root);

  let port;
  try {
    port = createRenderer(params);
    port.mount(canvas);
  } catch (error) {
    // Loud, never a silent downgrade to another port — but never a corpse
    // either: a partially built port is disposed and the overlay removed, so a
    // failed open leaves no GL context and no dead full-screen surface behind.
    const message = error instanceof Error ? error.message : String(error);
    try {
      port?.dispose();
    } catch {
      // dispose of a half-built port may itself throw; the open already failed
    }
    root.remove();
    live = null;
    reportUnavailable(message);
    return;
  }

  live = { root, canvas, hud, port, params, raf: 0, last: 0, hover: null };

  // --- interaction ---------------------------------------------------------
  /** @type {{x: number, y: number}|null} */
  let drag = null;
  /** where the current gesture started — a click is judged against THIS, not
   * against the previous move event, so a slow orbit made of many tiny moves
   * can never be mistaken for a click. */
  /** @type {{x: number, y: number}|null} */
  let gestureStart = null;
  let moved = false;
  canvas.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY };
    gestureStart = { x: event.clientX, y: event.clientY };
    moved = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (gestureStart && Math.hypot(event.clientX - gestureStart.x, event.clientY - gestureStart.y) > params.clickSlopPx) {
        moved = true;
      }
      port.camera.yaw += dx * params.orbitYawPerPx;
      port.camera.pitch = Math.max(
        -params.orbitPitchLimit,
        Math.min(params.orbitPitchLimit, port.camera.pitch + dy * params.orbitPitchPerPx),
      );
      drag = { x: event.clientX, y: event.clientY };
      return;
    }
    const hit = port.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (hit !== live?.hover && live) {
      live.hover = hit;
      hud.textContent = hudText(hit);
      canvas.style.cursor = hit ? "pointer" : "grab";
    }
  });
  canvas.addEventListener("pointerup", (event) => {
    drag = null;
    const start = gestureStart;
    gestureStart = null;
    if (moved) return;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > params.clickSlopPx) return;
    const rect = canvas.getBoundingClientRect();
    const hit = port.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (hit) void jumpToRoom(hit);
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    port.camera.distance = Math.max(
      params.cameraDistanceMin,
      Math.min(params.cameraDistanceMax, port.camera.distance * (1 + event.deltaY * params.zoomPerWheelUnit)),
    );
  }, { passive: false });

  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key === "Escape") {
      window.removeEventListener("keydown", onKey);
      closeArchtree();
    }
  };
  window.addEventListener("keydown", onKey);

  // --- loop ----------------------------------------------------------------
  const frame = (/** @type {number} */ now) => {
    if (!live) return;
    const model = buildModel(currentRooms(), { now: Date.now(), params: currentParams() });
    const minDelta = 1000 / (model.anyActive ? live.params.activeFps : live.params.idleFps);
    if (now - live.last >= minDelta) {
      live.last = now;
      live.port.update(model, layoutTree(model), now);
    }
    live.raf = requestAnimationFrame(frame);
  };
  live.raf = requestAnimationFrame(frame);
}
