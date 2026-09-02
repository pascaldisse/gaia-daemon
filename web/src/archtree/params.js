// Archtree tuning parameters. EVERY number the visualizer uses lives here as a
// named default; nothing downstream may hardcode a magnitude. Callers pass a
// partial override object (settings-driven) and get a fully-resolved set back.

/**
 * @typedef {Object} ArchtreeParams
 * @property {number} freshMs a finished lane still counts as "just done" (gold)
 * @property {number} witherMs older than this with no activity = dead/withered
 * @property {number} witherAnimMs how long the blackening crawl takes
 * @property {number} trunkHeight world units from root to first fork
 * @property {number} levelHeight vertical distance between tree levels
 * @property {number} spreadRadius horizontal radius of the widest ring
 * @property {number} branchJitter deterministic sideways wobble amplitude
 * @property {number} leafScale leaf-cluster size at depth 0
 * @property {number} leafFalloff leaf scale multiplier per depth level
 * @property {number} idleFps frame cap while no lane is running
 * @property {number} activeFps frame cap while any lane is running
 * @property {number} cameraFov vertical field of view, degrees
 * @property {number} cameraDistance initial orbit distance
 * @property {number} shadowMirror shadow half's vertical scale (1 = exact mirror)
 * @property {number} clickSlopPx pointer travel below which a gesture is a click
 * @property {number} orbitYawPerPx yaw radians per dragged pixel
 * @property {number} orbitPitchPerPx pitch radians per dragged pixel
 * @property {number} orbitPitchLimit pitch clamp in radians
 * @property {number} cameraDistanceMin closest orbit distance
 * @property {number} cameraDistanceMax farthest orbit distance
 * @property {number} zoomPerWheelUnit distance multiplier per wheel delta unit
 * @property {number} motesPerNode drifting particles emitted per animated node
 * @property {number} moteCycleMs one full spark-rise / ash-fall cycle
 * @property {number} moteTravel world units a mote travels over one cycle
 * @property {number} moteSwirlRadius sideways swirl radius of a mote
 * @property {number} moteSwirlMs period of the swirl rotation
 * @property {number} moteSizePx mote point size at the start of its cycle
 * @property {number} moteGlow mote emissive strength at the start of its cycle
 * @property {number} leafPixelScale leaf point size per world unit of leafScale
 * @property {number} leafPulseAmp active-leaf pulse amplitude (0 = no pulse)
 * @property {number} leafPulseMs active-leaf pulse period
 * @property {number} spritePixelRef canvas height the sprite sizes are authored for
 * @property {number} shadowSpriteScale sprite size multiplier in the shadow half
 * @property {number} witherResidualGlow glow left on a fully withered light branch
 * @property {number} cameraFramePad extra distance factor when auto-framing the tree
 * @property {number} branchAmbient ambient term of the branch lighting (0 = pure black in shade)
 * @property {number} branchDiffuse lambert term weight of the branch lighting
 * @property {number} branchRimStrength rim-light weight along the branch silhouette
 * @property {number} branchRimPower rim falloff exponent (higher = thinner rim)
 * @property {number} branchLightX key-light direction, x (tree space)
 * @property {number} branchLightY key-light direction, y
 * @property {number} branchLightZ key-light direction, z
 * @property {number} branchTipBias how far the tip colour reaches down a segment (0..1)
 * @property {number} branchGlowFloor lowest emissive weight a branch keeps (0 = may go black)
 * @property {number} mirrorSeamSpanFactor how far the 陽/陰 seam blend reaches, in trunkHeight units (0 = hard cut)
 * @property {number} leafClusterCount glowing leaf sprites per node
 * @property {number} leafClusterRadius world radius the leaf cluster spreads over
 * @property {number} leafClusterRise vertical lift of the leaf cluster above its node
 * @property {number} leafClusterSizeJitter size spread inside one cluster (0 = uniform)
 * @property {number} leafClusterSwayMs period of the slow leaf sway
 * @property {number} leafClusterSwayAmp world amplitude of the leaf sway
 * @property {number} moteRateActive mote-count multiplier for a running lane
 * @property {number} moteRateDone mote-count multiplier for a just-finished lane
 * @property {number} moteRateDead mote-count multiplier for a withered lane (ash)
 * @property {number} moteRateIdle mote-count multiplier for a quiet lane
 * @property {number} branchRadiusMin branch radius of a leaf node (world units)
 * @property {number} branchRadiusPerLane radius added per doubling of descendants
 * @property {number} branchRadiusLogBias offset inside the log so a leaf stays positive
 * @property {number} trunkThicknessFactor root segment radius relative to its node
 * @property {number} cameraNear near clip plane
 * @property {number} cameraFar far clip plane
 * @property {number} pickRadiusPx screen radius within which a click hits a node
 * @property {number} auraHaloFalloff exponential falloff of the central halo
 * @property {number} auraHaloAspect vertical stretch of the halo
 * @property {number} auraSkyLight sky tint weight of the light half
 * @property {number} auraSkyShadow sky tint weight of the shadow half
 * @property {number} auraHaloStrength halo brightness
 * @property {number} auraHaloTopBoost extra halo brightness towards the crown
 * @property {number} auraRayStrength godray brightness
 * @property {number} auraRayFrequency godray stripes across the screen
 * @property {number} auraRaySpeed godray drift speed
 * @property {string} renderer renderer port id
 * @property {string} gweUrl GAIA World Engine embed url ('' = port unavailable)
 */

/** @type {ArchtreeParams} */
export const DEFAULT_PARAMS = {
  freshMs: 15 * 60 * 1000,
  witherMs: 6 * 60 * 60 * 1000,
  witherAnimMs: 2500,
  trunkHeight: 2.2,
  levelHeight: 1.35,
  spreadRadius: 3.4,
  branchJitter: 0.22,
  leafScale: 0.55,
  leafFalloff: 0.78,
  idleFps: 20,
  activeFps: 60,
  cameraFov: 45,
  cameraDistance: 12,
  shadowMirror: 1,
  motesPerNode: 6,
  moteCycleMs: 2600,
  moteTravel: 2.2,
  moteSwirlRadius: 0.22,
  moteSwirlMs: 1400,
  moteSizePx: 34,
  moteGlow: 1.2,
  leafPixelScale: 420,
  leafPulseAmp: 0.25,
  leafPulseMs: 260,
  spritePixelRef: 900,
  shadowSpriteScale: 0.8,
  witherResidualGlow: 0.35,
  cameraFramePad: 1.6,
  // --- branch shading (renderer.js BRANCH_FS) ------------------------------
  branchAmbient: 0.34,
  branchDiffuse: 0.78,
  branchRimStrength: 0.5,
  branchRimPower: 2.2,
  branchLightX: 0.35,
  branchLightY: 0.86,
  branchLightZ: 0.38,
  branchTipBias: 0.55,
  branchGlowFloor: 0.55,
  // 陽 and 陰 meet at y=0 with DIFFERENT bark colour and status glow; without a
  // blend that difference lands on one pixel row and reads as a black hole in
  // the trunk (measured: lum 131 -> 36 across a single row, screenshots/before).
  mirrorSeamSpanFactor: 1,
  // --- leaf clusters + motes ----------------------------------------------
  leafClusterCount: 9,
  leafClusterRadius: 0.34,
  leafClusterRise: 0.16,
  leafClusterSizeJitter: 0.45,
  leafClusterSwayMs: 3700,
  leafClusterSwayAmp: 0.06,
  moteRateActive: 1,
  moteRateDone: 0.6,
  moteRateDead: 0.5,
  moteRateIdle: 0.2,
  // --- layout radii (layout.js) -------------------------------------------
  branchRadiusMin: 0.06,
  branchRadiusPerLane: 0.05,
  branchRadiusLogBias: 2,
  trunkThicknessFactor: 1.6,
  // --- camera / picking ----------------------------------------------------
  cameraNear: 0.1,
  cameraFar: 200,
  pickRadiusPx: 28,
  // --- aura backdrop (renderer.js AURA_FS) ---------------------------------
  auraHaloFalloff: 3.2,
  auraHaloAspect: 1.25,
  auraSkyLight: 0.2,
  auraSkyShadow: 0.1,
  auraHaloStrength: 0.35,
  auraHaloTopBoost: 0.25,
  auraRayStrength: 0.045,
  auraRayFrequency: 22,
  auraRaySpeed: 0.25,
  // --- interaction (index.js) ---------------------------------------------
  clickSlopPx: 6, // total pointer travel still counted as a click, not a drag
  orbitYawPerPx: 0.006, // radians of yaw per dragged pixel
  orbitPitchPerPx: 0.004, // radians of pitch per dragged pixel
  orbitPitchLimit: 1.2, // radians; keeps the camera off the poles
  cameraDistanceMin: 3,
  cameraDistanceMax: 60,
  zoomPerWheelUnit: 0.0012, // distance multiplier per wheel delta unit
  renderer: "webgl2",
  gweUrl: "",
};

/**
 * Resolve a partial override against the defaults. Unknown keys are ignored;
 * a key whose value has the wrong type falls back to the default (a bad
 * setting must never poison the view).
 * @param {Partial<ArchtreeParams>|null|undefined} overrides
 * @returns {ArchtreeParams}
 */
export function resolveParams(overrides) {
  const out = { ...DEFAULT_PARAMS };
  if (!overrides) return out;
  for (const key of /** @type {(keyof ArchtreeParams)[]} */ (Object.keys(DEFAULT_PARAMS))) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== typeof DEFAULT_PARAMS[key]) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    // @ts-expect-error key-wise assignment is homogeneous by the guard above
    out[key] = value;
  }
  return out;
}
