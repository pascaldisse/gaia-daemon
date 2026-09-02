// The renderer boundary. The view owns data + interaction; a port owns pixels.
// Two ports are foreseen (see DESIGN-ARCHTREE.md §1): the in-repo "webgl2" one
// and a "gwe" one that hands the same model to the GAIA World Engine. A port
// that cannot run says so LOUDLY (throws / reports unavailable) — the view
// never silently degrades to a different port than the one that was asked for.

/**
 * @typedef {Object} RendererPort
 * @property {(canvas: HTMLCanvasElement) => void} mount
 * @property {(model: import("./model.js").ArchtreeModel, layout: import("./layout.js").ArchtreeLayout, timeMs: number) => void} update
 * @property {(x: number, y: number) => string|null} pick canvas-space px -> node id
 * @property {() => void} dispose
 * @property {ArchtreeCamera} camera live orbit state the view drives directly
 */

/**
 * @typedef {Object} ArchtreeCamera
 * @property {number} yaw
 * @property {number} pitch
 * @property {number} distance
 * @property {number} targetY
 */

/** @typedef {(params: import("./params.js").ArchtreeParams) => RendererPort} RendererFactory */

/** @type {Map<string, RendererFactory>} */
const ports = new Map();

/**
 * @param {string} id
 * @param {RendererFactory} factory
 */
export function registerRenderer(id, factory) {
  ports.set(id, factory);
}

/** @returns {string[]} */
export function rendererIds() {
  return [...ports.keys()];
}

/**
 * @param {import("./params.js").ArchtreeParams} params
 * @returns {RendererPort}
 */
export function createRenderer(params) {
  const factory = ports.get(params.renderer);
  if (!factory) throw new Error(`archtree: unknown renderer "${params.renderer}" (have: ${rendererIds().join(", ") || "none"})`);
  return factory(params);
}
