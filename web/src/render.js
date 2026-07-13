// Regional rendering with a dirty set. markDirty(region...) marks regions
// dirty; one rAF flush re-renders only what changed, in a fixed order. Feature
// modules register their region renderer at import time — this module knows
// no features, so there are no import cycles.

import { $, h } from "./dom.js";
import { state } from "./state.js";

/** @typedef {"layout"|"tabs"|"sidebar"|"panel"|"status"|"transcript"|"composer"|"dario"|"contextgate"|"theme"|"usage"|"search"|"bgtasks"|"settings"} Region */

const ORDER = /** @type {Region[]} */ (["layout", "tabs", "sidebar", "panel", "status", "transcript", "composer", "dario", "contextgate", "theme", "usage", "search", "bgtasks", "settings"]);

/** @type {Map<Region, () => void>} */
const renderers = new Map();

/** @type {Set<Region>} */
const dirty = new Set();
let scheduled = false;

/** @param {Region} region @param {() => void} renderer */
export function registerRegion(region, renderer) {
  renderers.set(region, renderer);
}

/**
 * Mark regions dirty and schedule a flush. With no arguments, everything is
 * marked (the "snapshot changed" case).
 * @param {...Region} regions
 */
export function markDirty(...regions) {
  for (const region of regions.length > 0 ? regions : ORDER) dirty.add(region);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(flushRegions);
}

function flushRegions() {
  scheduled = false;
  const run = ORDER.filter((region) => dirty.has(region));
  dirty.clear();
  for (const region of run) renderers.get(region)?.();
}

/** @param {unknown} error */
export function setError(error) {
  state.error = error instanceof Error ? error.message : String(error ?? "");
  markDirty("status");
}

/** Dismiss the current error banner, if any. */
export function clearError() {
  if (!state.error) return;
  state.error = "";
  markDirty("status");
}

// ---------------------------------------------------------------------------
// Static skeleton, mounted once. Regions render INTO these containers; the
// transcript node in particular is never replaced, so its keyed per-event
// children survive every other region's re-render.

export function mountApp() {
  const root = $("#app");
  if (!root) return;
  root.replaceChildren(
    h("header", { class: "tabbar", id: "tabbar" }),
    h(
      "div",
      { class: "body", id: "body" },
      h("nav", { class: "sidebar", id: "sidebar" }),
      h("div", { class: "scrim", id: "scrim", onclick: () => { void import("./chrome.js").then((mod) => mod.closeSidebarOverlay()); } }),
      h("div", { class: "col-resizer", id: "resizer-left", title: "drag to resize", onpointerdown: (event) => startResize(event, "left") }),
      h(
        "main",
        { class: "main" },
        h("header", { class: "topbar", id: "topbar" }),
        h(
          "div",
          { class: "main-stack" },
          h("div", { class: "error", id: "error", hidden: true }),
          h("section", { class: "transcript", id: "transcript" }),
        ),
        h("form", { class: "composer", id: "composer" }),
      ),
      h("div", { class: "col-resizer", id: "resizer-right", title: "drag to resize", onpointerdown: (event) => startResize(event, "right") }),
      h(
        "aside",
        { class: "right", id: "right" },
        h("section", { class: "panel", id: "room-panel" }),
      ),
    ),
    h("footer", { class: "statusbar", id: "statusbar" }),
    // Overlay slots: the theme palette and other overlays render into their
    // own mount points, so neither region's re-render can touch the other.
    h(
      "div",
      { id: "overlays" },
      h("div", { id: "overlay-dario" }),
      h("div", { id: "overlay-contextgate" }),
      h("div", { id: "overlay-theme" }),
      h("div", { id: "overlay-usage" }),
      h("div", { id: "overlay-bgtasks" }),
      h("div", { id: "overlay-search" }),
      h("div", { id: "overlay-settings" }),
    ),
  );
}

// Layout region: pane collapse (Ctrl+B / Ctrl+G) toggles grid columns. The
// children stay in the DOM (hidden), so no region loses its rendered state.
function renderLayout() {
  const body = $("#body");
  const sidebar = $("#sidebar");
  const left = $("#resizer-left");
  const scrim = $("#scrim");
  const right = $("#right");
  const rightResizer = $("#resizer-right");
  if (!body || !sidebar || !left || !right || !rightResizer) return;
  sidebar.hidden = state.sidebarCollapsed;
  if (scrim) scrim.hidden = state.sidebarCollapsed;
  left.hidden = state.sidebarCollapsed;
  right.hidden = state.rightCollapsed;
  rightResizer.hidden = state.rightCollapsed;
  const cols = [];
  if (!state.sidebarCollapsed) cols.push("var(--w-left)", "5px");
  cols.push("minmax(0,1fr)");
  if (!state.rightCollapsed) cols.push("5px", "var(--w-right)");
  body.style.gridTemplateColumns = cols.join(" ");
}

registerRegion("layout", renderLayout);

// Drag handle between panes. Resizing rewrites the width CSS var on :root and
// persists it, so panes stay where the user put them across reloads.
/** @param {PointerEvent} event @param {"left"|"right"} side */
function startResize(event, side) {
  event.preventDefault();
  const root = document.documentElement;
  const varName = side === "left" ? "--w-left" : "--w-right";
  const startX = event.clientX;
  const start = parseInt(getComputedStyle(root).getPropertyValue(varName), 10) || (side === "left" ? 260 : 340);
  /** @param {PointerEvent} move */
  const onMove = (move) => {
    const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
    const next = Math.max(160, Math.min(560, start + delta));
    root.style.setProperty(varName, `${next}px`);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.classList.remove("resizing");
    try {
      localStorage.setItem(
        "gaia.cols",
        JSON.stringify({ left: root.style.getPropertyValue("--w-left"), right: root.style.getPropertyValue("--w-right") }),
      );
    } catch {
      // storage disabled — widths just won't persist.
    }
  };
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
