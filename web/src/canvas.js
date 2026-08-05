// Design canvas for GAIA — Dieter's workspace
// Embedded Figma-killer: vector editing, real-time agent manipulation

import { $ } from "./dom.js";

/**
 * Design canvas state
 * @typedef {{
 *   elements: DesignElement[],
 *   selectedId: string|null,
 *   zoom: number,
 *   pan: {x: number, y: number},
 *   visible: boolean
 * }} CanvasState
 */

/**
 * Design element (frame, shape, text, etc.)
 * @typedef {{
 *   id: string,
 *   type: string,
 *   name: string,
 *   x: number,
 *   y: number,
 *   width: number,
 *   height: number,
 *   fill: string,
 *   stroke: {color: string, width: number},
 *   children: DesignElement[]
 * }} DesignElement
 */

/** @type {CanvasState} */
const canvasState = {
  elements: [],
  selectedId: null,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  visible: false
};

/**
 * Toggle canvas visibility
 */
export function toggleCanvas() {
  canvasState.visible = !canvasState.visible;
  renderCanvas();
}

/**
 * Show canvas
 */
export function showCanvas() {
  canvasState.visible = true;
  renderCanvas();
}

/**
 * Hide canvas
 */
export function hideCanvas() {
  canvasState.visible = false;
  renderCanvas();
}

/**
 * Create new design element
 * @param {string} type - Element type
 * @param {Partial<DesignElement>} props - Element properties
 * @returns {string} Element ID
 */
export function createElement(type, props = {}) {
  const id = `el-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  /** @type {DesignElement} */
  const element = {
    id,
    type,
    name: props.name || `${type} ${canvasState.elements.length + 1}`,
    x: props.x !== undefined ? props.x : 100,
    y: props.y !== undefined ? props.y : 100,
    width: props.width !== undefined ? props.width : 200,
    height: props.height !== undefined ? props.height : 200,
    fill: props.fill || "#ffffff",
    stroke: props.stroke || { color: "#000000", width: 1 },
    children: []
  };
  
  canvasState.elements.push(element);
  renderCanvas();
  
  return id;
}

/**
 * Update element properties
 * @param {string} id - Element ID
 * @param {Partial<DesignElement>} props - Properties to update
 */
export function updateElement(id, props) {
  const element = canvasState.elements.find(el => el.id === id);
  if (!element) return;
  
  Object.assign(element, props);
  renderCanvas();
}

/**
 * Delete element
 * @param {string} id - Element ID
 */
export function deleteElement(id) {
  canvasState.elements = canvasState.elements.filter(el => el.id !== id);
  if (canvasState.selectedId === id) {
    canvasState.selectedId = null;
  }
  renderCanvas();
}

/**
 * Select element
 * @param {string} id - Element ID
 */
export function selectElement(id) {
  canvasState.selectedId = id;
  renderCanvas();
}

/**
 * Get all elements
 * @returns {DesignElement[]}
 */
export function getElements() {
  return canvasState.elements;
}

/**
 * Clear canvas
 */
export function clearCanvas() {
  canvasState.elements = [];
  canvasState.selectedId = null;
  renderCanvas();
}

/**
 * Export canvas as JSON
 * @returns {object}
 */
export function exportCanvas() {
  return {
    version: "1.0",
    elements: canvasState.elements,
    zoom: canvasState.zoom,
    pan: canvasState.pan
  };
}

/**
 * Import canvas from JSON
 * @param {{elements?: DesignElement[], zoom?: number, pan?: {x: number, y: number}}} data - Canvas data
 */
export function importCanvas(data) {
  canvasState.elements = data.elements || [];
  canvasState.zoom = data.zoom || 1.0;
  canvasState.pan = data.pan || { x: 0, y: 0};
  canvasState.selectedId = null;
  renderCanvas();
}

/**
 * Render SVG element
 * @param {DesignElement} el - Element to render
 * @returns {string} SVG markup
 */
function renderElement(el) {
  const isSelected = el.id === canvasState.selectedId;
  const selectionStroke = isSelected ? 'stroke="#2563eb" stroke-width="2"' : '';
  
  switch (el.type) {
    case 'rectangle':
      return `<rect 
        id="${el.id}"
        x="${el.x}" 
        y="${el.y}" 
        width="${el.width}" 
        height="${el.height}" 
        fill="${el.fill}" 
        stroke="${el.stroke.color}" 
        stroke-width="${el.stroke.width}"
        ${selectionStroke}
        class="canvas-element"
        data-id="${el.id}"
      />`;
      
    case 'circle':
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      const r = Math.min(el.width, el.height) / 2;
      return `<circle 
        id="${el.id}"
        cx="${cx}" 
        cy="${cy}" 
        r="${r}" 
        fill="${el.fill}" 
        stroke="${el.stroke.color}" 
        stroke-width="${el.stroke.width}"
        ${selectionStroke}
        class="canvas-element"
        data-id="${el.id}"
      />`;
      
    case 'text':
      return `<text 
        id="${el.id}"
        x="${el.x}" 
        y="${el.y + 20}" 
        fill="${el.fill}" 
        font-size="16"
        ${selectionStroke}
        class="canvas-element"
        data-id="${el.id}"
      >${el.name}</text>`;
      
    case 'frame':
      return `<g id="${el.id}" class="canvas-element" data-id="${el.id}">
        <rect 
          x="${el.x}" 
          y="${el.y}" 
          width="${el.width}" 
          height="${el.height}" 
          fill="none" 
          stroke="${isSelected ? '#2563eb' : '#d1d5db'}" 
          stroke-width="2"
          stroke-dasharray="4,4"
        />
        <text 
          x="${el.x}" 
          y="${el.y - 5}" 
          fill="#6b7280" 
          font-size="12"
        >${el.name}</text>
        ${el.children.map(renderElement).join('')}
      </g>`;
      
    default:
      return '';
  }
}

/**
 * Render canvas UI
 */
function renderCanvas() {
  const container = $("#design-canvas-container");
  if (!container) return;
  
  if (!canvasState.visible) {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'flex';
  
  const layersList = canvasState.elements.map(el => {
    const selectedClass = el.id === canvasState.selectedId ? 'selected' : '';
    return `
      <div 
        class="layer-item ${selectedClass}"
        data-layer-id="${el.id}"
      >
        <span class="layer-type">${el.type}</span>
        <span class="layer-name">${el.name}</span>
      </div>
    `;
  }).join('');
  
  container.innerHTML = `
    <div class="design-canvas-panel">
      <div class="design-canvas-header">
        <div class="design-canvas-title">
          <span>🎨 Design Canvas</span>
          <span class="canvas-element-count">${canvasState.elements.length} elements</span>
        </div>
        <div class="design-canvas-controls">
          <button id="canvas-zoom-in" title="Zoom in">+</button>
          <span class="zoom-level">${Math.round(canvasState.zoom * 100)}%</span>
          <button id="canvas-zoom-out" title="Zoom out">−</button>
          <button id="canvas-clear" title="Clear canvas">🗑️</button>
          <button id="canvas-close" title="Close">✕</button>
        </div>
      </div>
      
      <div class="design-canvas-viewport">
        <svg 
          class="design-canvas-svg"
          width="100%" 
          height="100%"
          viewBox="0 0 1440 900"
        >
          <defs>
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e5e7eb" stroke-width="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
          ${canvasState.elements.map(renderElement).join('')}
        </svg>
      </div>
      
      <div class="design-canvas-layers">
        <div class="layers-title">Layers</div>
        <div class="layers-list">
          ${layersList}
        </div>
      </div>
    </div>
  `;
  
  // Attach event handlers
  const zoomIn = $("#canvas-zoom-in", container);
  const zoomOut = $("#canvas-zoom-out", container);
  const clear = $("#canvas-clear", container);
  const close = $("#canvas-close", container);
  
  if (zoomIn) zoomIn.onclick = () => {
    canvasState.zoom = Math.min(canvasState.zoom * 1.2, 5);
    renderCanvas();
  };
  
  if (zoomOut) zoomOut.onclick = () => {
    canvasState.zoom = Math.max(canvasState.zoom / 1.2, 0.1);
    renderCanvas();
  };
  
  if (clear) clear.onclick = () => {
    if (confirm('Clear entire canvas?')) {
      clearCanvas();
    }
  };
  
  if (close) close.onclick = () => {
    hideCanvas();
  };
  
  // Attach layer click handlers
  const layerItems = container.querySelectorAll('.layer-item');
  layerItems.forEach(item => {
    const htmlItem = /** @type {HTMLElement} */ (item);
    htmlItem.onclick = () => {
      const id = item.getAttribute('data-layer-id');
      if (id) selectElement(id);
    };
  });
  
  // Attach canvas element click handlers
  const canvasElements = container.querySelectorAll('.canvas-element');
  canvasElements.forEach(el => {
    const svgEl = /** @type {SVGElement & {onclick: ((e: MouseEvent) => void) | null}} */ (el);
    svgEl.onclick = (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-id');
      if (id) selectElement(id);
    };
  });
}

// Initialize canvas container
export function initCanvas() {
  const existing = $("#design-canvas-container");
  if (existing) return;
  
  const container = document.createElement("div");
  container.id = "design-canvas-container";
  container.className = "design-canvas-root";
  document.body.appendChild(container);
  
  // Apply initial hidden state
  renderCanvas();
}

// Export canvas API
export const canvas = {
  show: showCanvas,
  hide: hideCanvas,
  toggle: toggleCanvas,
  createElement,
  updateElement,
  deleteElement,
  selectElement,
  getElements,
  clear: clearCanvas,
  export: exportCanvas,
  import: importCanvas
};
