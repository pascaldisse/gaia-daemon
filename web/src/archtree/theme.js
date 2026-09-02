// Palette + material parameters for both halves. Colors are linear-ish RGB
// triples in 0..1; nothing in the renderer may name a color literally.

/** @typedef {[number, number, number]} Rgb */

/**
 * @typedef {Object} HalfTheme
 * @property {Rgb} bark trunk/branch base
 * @property {Rgb} barkTip branch colour at the tips
 * @property {Rgb} aura background halo
 * @property {Rgb} active running lane
 * @property {Rgb} done finished lane
 * @property {Rgb} dead withered lane
 * @property {Rgb} idle quiet lane
 * @property {Rgb} mote drifting particle colour
 * @property {number} moteRise +1 = sparks rise (light), -1 = ash falls (shadow)
 * @property {number} glow emissive multiplier
 * @property {StatusGlowFactors} statusGlowFactor per-status emissive factor of this half
 */

/**
 * Per-status emissive factors of one half. Named because the inversion between
 * the halves IS the design statement (§3): the shadow tree burns where the
 * light tree dies, so these four numbers per half must be readable, not buried
 * in an if-chain.
 * @typedef {Object} StatusGlowFactors
 * @property {number} active
 * @property {number} done
 * @property {number} dead
 * @property {number} idle
 */

/** 陽: life glows, death dulls. @type {StatusGlowFactors} */
export const LIGHT_STATUS_GLOW = { active: 1.4, done: 1.1, dead: 0.35, idle: 0.5 };

/** 陰: death burns, life recedes. @type {StatusGlowFactors} */
export const SHADOW_STATUS_GLOW = { active: 0.5, done: 0.4, dead: 1.6, idle: 0.5 };

/** Erdtree / Yggdrasil: gold, warm, rising sparks. @type {HalfTheme} */
export const LIGHT_THEME = {
  bark: [0.42, 0.33, 0.18],
  barkTip: [0.95, 0.79, 0.38],
  aura: [1.0, 0.81, 0.42],
  active: [0.42, 1.0, 0.55],
  done: [1.0, 0.84, 0.35],
  dead: [0.62, 0.24, 0.2],
  idle: [0.45, 0.44, 0.36],
  mote: [1.0, 0.88, 0.55],
  moteRise: 1,
  glow: 1.0,
  statusGlowFactor: LIGHT_STATUS_GLOW,
};

/** Scorched erdtree / Bloodborne: ash, bone, blood. @type {HalfTheme} */
export const SHADOW_THEME = {
  // ash, not void: at 0.09 the near-root trunk read as a black hole in the
  // overview shot (screenshots/before/) instead of as charred wood
  bark: [0.19, 0.17, 0.18],
  barkTip: [0.55, 0.53, 0.48],
  aura: [0.35, 0.42, 0.36],
  active: [0.2, 0.5, 0.3],
  done: [0.45, 0.4, 0.3],
  dead: [0.75, 0.13, 0.13],
  idle: [0.16, 0.16, 0.18],
  mote: [0.55, 0.55, 0.5],
  moteRise: -1,
  glow: 0.55,
  statusGlowFactor: SHADOW_STATUS_GLOW,
};

/**
 * Status colour of a node within one half. The shadow tree is brightest where
 * the light tree dies — the mirror is not a copy, it is the inverse reading.
 * @param {HalfTheme} theme
 * @param {import("./model.js").ArchtreeStatus} status
 * @returns {Rgb}
 */
export function statusColor(theme, status) {
  if (status === "active") return theme.active;
  if (status === "done") return theme.done;
  if (status === "dead") return theme.dead;
  return theme.idle;
}

/**
 * Emissive strength for a node: dead branches glow in the shadow half and go
 * dull in the light half.
 * @param {HalfTheme} theme
 * @param {import("./model.js").ArchtreeStatus} status
 * @returns {number}
 */
export function statusGlow(theme, status) {
  const factors = theme.statusGlowFactor;
  if (status === "active") return theme.glow * factors.active;
  if (status === "done") return theme.glow * factors.done;
  if (status === "dead") return theme.glow * factors.dead;
  return theme.glow * factors.idle;
}
