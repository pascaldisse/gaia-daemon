// Deliberately small design canvas: absolute box/text elements only. It is an
// editor for artifact JSON, not a general-purpose drawing surface.
import { h } from "./dom.js";

/** @typedef {{ id: string, kind: "box"|"text", x: number, y: number, w: number, h: number, text?: string, fill?: string, color?: string, fontSize?: number }} DesignElement */
/** @typedef {{ elements: DesignElement[] }} Design */

/** @type {string|null} */
let selectedElementId = null;

/** @param {string} content @param {(content: string) => void} onChange @returns {HTMLElement} */
export function ArtifactCanvas(content, onChange) {
  const design = parseDesign(content);
  if (!design.elements.some((element) => element.id === selectedElementId)) selectedElementId = null;
  const stage = h("div", { class: "artifact-design-stage", tabindex: "0", onkeydown: (event) => onStageKeydown(event, design, onChange, stage) });
  for (const element of design.elements) stage.append(ElementNode(element, design, stage, onChange));
  return h("div", { class: "artifact-canvas-wrap" }, stage);
}

/** @param {string} content @returns {Design} */
function parseDesign(content) {
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(content));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(/** @type {{ elements?: unknown }} */ (parsed).elements)) return { elements: [] };
    return {
      elements: /** @type {unknown[]} */ (/** @type {{ elements: unknown[] }} */ (parsed).elements)
        .filter(isDesignElement)
        .map((element) => ({ ...element })),
    };
  } catch {
    return { elements: [] };
  }
}

/** @param {unknown} value @returns {value is DesignElement} */
function isDesignElement(value) {
  if (!value || typeof value !== "object") return false;
  const element = /** @type {{ id?: unknown, kind?: unknown, x?: unknown, y?: unknown, w?: unknown, h?: unknown }} */ (value);
  return (
    typeof element.id === "string" &&
    (element.kind === "box" || element.kind === "text") &&
    [element.x, element.y, element.w, element.h].every((number) => typeof number === "number" && Number.isFinite(number))
  );
}

/** @param {DesignElement} element @param {Design} design @param {HTMLElement} stage @param {(content: string) => void} onChange */
function ElementNode(element, design, stage, onChange) {
  const node = h("div", {
    class: `artifact-design-element ${element.kind} ${element.id === selectedElementId ? "selected" : ""}`,
    "data-element-id": element.id,
    style: elementStyle(element),
    onpointerdown: (event) => startPointerEdit(event, "move", element, design, stage, onChange),
  });
  if (element.kind === "text") {
    const text = h("div", { class: "artifact-design-text", text: element.text ?? "text" });
    text.addEventListener("dblclick", () => beginTextEdit(text, element, design, onChange));
    node.append(text);
  }
  for (const corner of ["nw", "ne", "sw", "se"]) {
    node.append(
      h("span", {
        class: `artifact-resize-handle ${corner}`,
        "data-corner": corner,
        onpointerdown: (event) => startPointerEdit(event, "resize", element, design, stage, onChange, corner),
      }),
    );
  }
  return node;
}

/** @param {DesignElement} element */
function elementStyle(element) {
  const fill = element.fill ?? (element.kind === "box" ? "var(--accent)" : "transparent");
  const color = element.color ?? "var(--fg)";
  const fontSize = element.fontSize ?? 16;
  return `left:${element.x}px;top:${element.y}px;width:${element.w}px;height:${element.h}px;background:${fill};color:${color};font-size:${fontSize}px;`;
}

/** @param {PointerEvent} event @param {"move"|"resize"} mode @param {DesignElement} element @param {Design} design @param {HTMLElement} stage @param {(content: string) => void} onChange @param {string} [corner] */
function startPointerEdit(event, mode, element, design, stage, onChange, corner) {
  event.preventDefault();
  event.stopPropagation();
  selectElement(stage, element.id);
  const startX = event.clientX;
  const startY = event.clientY;
  const initial = { x: element.x, y: element.y, w: element.w, h: element.h };
  const node = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.currentTarget).closest(".artifact-design-element"));
  if (!node) return;
  /** @param {PointerEvent} next */
  const move = (next) => {
    const dx = next.clientX - startX;
    const dy = next.clientY - startY;
    if (mode === "move") {
      element.x = Math.round(initial.x + dx);
      element.y = Math.round(initial.y + dy);
    } else {
      resizeElement(element, initial, corner ?? "se", dx, dy);
    }
    node.style.cssText = elementStyle(element);
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    onChange(JSON.stringify(design, null, 2));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}

/** @param {DesignElement} element @param {{x:number,y:number,w:number,h:number}} initial @param {string} corner @param {number} dx @param {number} dy */
function resizeElement(element, initial, corner, dx, dy) {
  const min = 24;
  const west = corner.includes("w");
  const north = corner.includes("n");
  const width = Math.max(min, initial.w + (west ? -dx : dx));
  const height = Math.max(min, initial.h + (north ? -dy : dy));
  element.w = Math.round(width);
  element.h = Math.round(height);
  element.x = Math.round(west ? initial.x + initial.w - width : initial.x);
  element.y = Math.round(north ? initial.y + initial.h - height : initial.y);
}

/** @param {HTMLElement} stage @param {string|null} id */
function selectElement(stage, id) {
  selectedElementId = id;
  for (const node of stage.querySelectorAll(".artifact-design-element")) {
    node.classList.toggle("selected", /** @type {HTMLElement} */ (node).dataset.elementId === id);
  }
  stage.focus();
}

/** @param {HTMLElement} text @param {DesignElement} element @param {Design} design @param {(content: string) => void} onChange */
function beginTextEdit(text, element, design, onChange) {
  text.contentEditable = "true";
  text.focus();
  const finish = () => {
    text.contentEditable = "false";
    element.text = text.textContent ?? "";
    onChange(JSON.stringify(design, null, 2));
  };
  text.addEventListener("blur", finish, { once: true });
  text.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        text.textContent = element.text ?? "";
        text.blur();
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        text.blur();
      }
    },
    { once: false },
  );
}

/** @param {KeyboardEvent} event @param {Design} design @param {(content: string) => void} onChange @param {HTMLElement} stage */
function onStageKeydown(event, design, onChange, stage) {
  if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
  if (event.key === "Escape") {
    event.preventDefault();
    selectElement(stage, null);
    return;
  }
  if (event.key !== "Delete" || !selectedElementId) return;
  event.preventDefault();
  design.elements = design.elements.filter((element) => element.id !== selectedElementId);
  selectedElementId = null;
  onChange(JSON.stringify(design, null, 2));
}
