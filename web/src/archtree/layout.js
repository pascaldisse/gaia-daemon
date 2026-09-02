// Deterministic 3D layout for the archtree. Pure: same model in, same points
// out, every frame — nodes may not wander between updates.
//
// Shape: a radial-fan tree. The root sits at the origin, the trunk rises by
// params.trunkHeight, each further depth level adds params.levelHeight and
// fans its siblings around the parent's azimuth within a shrinking wedge, so
// deep branches stay near their parent instead of crossing the whole crown.

/** @typedef {import("./model.js").ArchtreeModel} ArchtreeModel */
/** @typedef {import("./model.js").ArchtreeNode} ArchtreeNode */

/**
 * @typedef {Object} ArchtreePoint
 * @property {string} id
 * @property {number} x
 * @property {number} y height above the root (light half; shadow mirrors it)
 * @property {number} z
 * @property {number} azimuth radians, for child fanning
 * @property {number} wedge angular width this node may hand to its children
 * @property {number} thickness branch radius, from descendant count
 */

/**
 * @typedef {Object} ArchtreeLayout
 * @property {Map<string, ArchtreePoint>} points
 * @property {Array<{from: ArchtreePoint, to: ArchtreePoint}>} segments
 * @property {number} height topmost y
 * @property {number} radius widest horizontal extent
 */

const TAU = Math.PI * 2;

// --- named mathematical constants (no magic numbers in the layout) ----------
/** FNV-1a 32-bit offset basis / prime: the standard string-hash constants */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
/** largest uint32, used to normalise a hash into 0..1 */
const U32_MAX = 0xffffffff;
/** 0..1 -> -1..1 */
const UNIT_TO_SIGNED_SCALE = 2;
const UNIT_TO_SIGNED_OFFSET = 1;
/** centre of a slot: sibling i occupies [i, i+1), its middle is i + 0.5 */
const SLOT_CENTER = 0.5;
/** a fan is centred on the parent azimuth, so slots run -0.5 .. +0.5 */
const FAN_CENTER_SHIFT = 0.5;

/**
 * Stable pseudo-random in [-1, 1] from a string — gives branches organic
 * asymmetry without a frame-varying RNG.
 * @param {string} seed
 * @returns {number}
 */
export function jitterOf(seed) {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return ((hash >>> 0) / U32_MAX) * UNIT_TO_SIGNED_SCALE - UNIT_TO_SIGNED_OFFSET;
}

/**
 * @param {ArchtreeModel} model
 * @returns {ArchtreeLayout}
 */
export function layoutTree(model) {
  const { params } = model;
  /** @type {Map<string, ArchtreePoint>} */
  const points = new Map();
  /** @type {Array<{from: ArchtreePoint, to: ArchtreePoint}>} */
  const segments = [];
  let height = 0;
  let radius = 0;

  const depthSpan = Math.max(1, model.maxDepth);

  for (const node of model.nodes) {
    const parent = node.parentId ? points.get(node.parentId) : undefined;
    const wedgeBase = parent ? parent.wedge : TAU;
    const wedge = node.siblings > 0 ? wedgeBase / Math.max(1, node.siblings) : wedgeBase;
    const slot = node.siblings > 1 ? (node.index + SLOT_CENTER) / node.siblings - FAN_CENTER_SHIFT : 0;
    const azimuth = (parent ? parent.azimuth : 0) + slot * wedgeBase;

    // radial distance grows with depth but saturates, so a deep tree stays
    // inside the same visual crown instead of exploding outward
    const depthFrac = node.depth / depthSpan;
    const reach = params.spreadRadius * Math.sqrt(Math.min(1, depthFrac));
    const wobble = jitterOf(node.id) * params.branchJitter;

    const x = parent ? parent.x + Math.cos(azimuth) * (reach - Math.hypot(parent.x, parent.z)) + wobble : 0;
    const z = parent ? parent.z + Math.sin(azimuth) * (reach - Math.hypot(parent.x, parent.z)) + wobble : 0;
    const y = node.depth === 0 ? params.trunkHeight : params.trunkHeight + node.depth * params.levelHeight;

    // a branch carrying more lanes is thicker, but logarithmically: a 200-room
    // subtree must not become a wall
    const thickness =
      params.branchRadiusMin +
      Math.log2(node.descendants + params.branchRadiusLogBias) * params.branchRadiusPerLane;
    /** @type {ArchtreePoint} */
    const point = { id: node.id, x, y, z, azimuth, wedge, thickness };
    points.set(node.id, point);

    if (height < y) height = y;
    const horiz = Math.hypot(x, z);
    if (radius < horiz) radius = horiz;

    if (parent) segments.push({ from: parent, to: point });
    else
      segments.push({
        from: { id: "__root__", x: 0, y: 0, z: 0, azimuth: 0, wedge: TAU, thickness: thickness * params.trunkThicknessFactor },
        to: point,
      });
  }

  return { points, segments, height, radius };
}
