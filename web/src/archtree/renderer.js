// The in-repo renderer port: raw WebGL2, zero dependencies, no build step.
// Deliberately not three.js (see DESIGN-ARCHTREE.md §0): the web client is
// bundler-less ESM served straight from the daemon, and this scene is a few
// hundred instances of two primitives.
//
// Everything is drawn twice: 陽 (uYScale +1, LIGHT_THEME) and 陰 (uYScale
// -params.shadowMirror, SHADOW_THEME). Same geometry buffers, inverted
// material language — the shadow tree is the same truth seen from below.

import { registerRenderer } from "./port.js";
import { LIGHT_THEME, SHADOW_THEME, statusColor, statusGlow } from "./theme.js";

/** @typedef {import("./params.js").ArchtreeParams} ArchtreeParams */
/** @typedef {import("./model.js").ArchtreeModel} ArchtreeModel */
/** @typedef {import("./layout.js").ArchtreeLayout} ArchtreeLayout */
/** @typedef {import("./theme.js").HalfTheme} HalfTheme */

// --- minimal 4x4 math (column-major, GL order) ------------------------------

/** @returns {Float32Array} */
function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/**
 * @param {number} fovDeg @param {number} aspect @param {number} near @param {number} far
 * @returns {Float32Array}
 */
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * @param {number[]} eye @param {number[]} center @param {number[]} up
 * @returns {Float32Array}
 */
function lookAt(eye, center, up) {
  const zx = eye[0] - center[0];
  const zy = eye[1] - center[1];
  const zz = eye[2] - center[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  const z = [zx / zl, zy / zl, zz / zl];
  const xx = up[1] * z[2] - up[2] * z[1];
  const xy = up[2] * z[0] - up[0] * z[2];
  const xz = up[0] * z[1] - up[1] * z[0];
  const xl = Math.hypot(xx, xy, xz) || 1;
  const x = [xx / xl, xy / xl, xz / xl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const out = identity();
  out[0] = x[0]; out[4] = x[1]; out[8] = x[2];
  out[1] = y[0]; out[5] = y[1]; out[9] = y[2];
  out[2] = z[0]; out[6] = z[1]; out[10] = z[2];
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  return out;
}

/** @param {Float32Array} a @param {Float32Array} b @returns {Float32Array} */
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

// --- shaders ----------------------------------------------------------------

/** angular step between two motes of the same node (radians) — spreads the swirl */
const MOTE_SWIRL_STEP = 1.7;

/** golden angle (radians): distributes cluster members without visible rows */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** quarter turn: maps aSide -1..+1 onto a half-cylinder normal sweep */
const QUARTER_TURN = Math.PI / 2;

/** FNV-1a seed/prime — the deterministic per-node hash used for cluster jitter */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const U32_MAX = 0xffffffff;

/** NDC → viewport: clip.xy/w is -1..1, screen wants 0..1 before the pixel scale */
const NDC_TO_UNIT_SCALE = 0.5;
const NDC_TO_UNIT_OFFSET = 0.5;

/** shader time is fed in seconds */
const MS_PER_SECOND = 1000;

/** clear colour: the void behind the aura, darker than any theme sky */
const BACKDROP = [0.02, 0.02, 0.03];

/**
 * Deterministic 0..1 hash of a string — same node, same cluster, every frame.
 * @param {string} seed @param {number} salt
 * @returns {number}
 */
function hash01(seed, salt) {
  let hash = FNV_OFFSET_BASIS ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) / U32_MAX;
}

const BRANCH_VS = `#version 300 es
precision highp float;
in vec3 aPos;      // segment vertex in tree space
in vec3 aOther;    // the segment's other endpoint (for the billboard axis)
in float aSide;    // -1 / +1 across the branch
in float aFlip;    // +1 at the segment's start vertex, -1 at its end vertex
in float aRadius;
in vec3 aColor;
in float aGlow;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uYScale;
uniform float uQuarterTurn;
out vec3 vColor;
out float vGlow;
out float vSide;
out vec3 vNormal;
out vec3 vToEye;
void main() {
  vec3 p = vec3(aPos.x, aPos.y * uYScale, aPos.z);
  vec3 q = vec3(aOther.x, aOther.y * uYScale, aOther.z);
  // The axis must point the SAME way for both endpoints of a segment,
  // otherwise the side vector flips at the far end and the quad folds into a
  // bow-tie — that fold, not the lighting alone, drew the black wedge across
  // the trunk in screenshots/before/.
  vec3 axis = normalize((q - p) * aFlip + vec3(1e-5));
  vec3 toEye = normalize(uEye - p);
  vec3 side = normalize(cross(axis, toEye));
  // A flat billboard shaded flat is exactly what produced the black facets.
  // The quad stands in for a cylinder, so the normal must be the CYLINDER's:
  // sweep from the eye-facing direction at the middle to the silhouette
  // direction at either edge. That is a smooth field across the quad and
  // across neighbouring segments — no facet break can survive it.
  vec3 faceEye = normalize(cross(side, axis));
  float a = aSide * uQuarterTurn;
  vNormal = normalize(side * sin(a) + faceEye * cos(a));
  vToEye = toEye;
  gl_Position = uViewProj * vec4(p + side * aSide * aRadius, 1.0);
  vColor = aColor;
  vGlow = aGlow;
  vSide = aSide;
}`;

const BRANCH_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vGlow;
in float vSide;
in vec3 vNormal;
in vec3 vToEye;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uRimStrength;
uniform float uRimPower;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  // wrapped lambert: the unlit side darkens but never collapses to black,
  // which is what the hard facets looked like in the overview shot
  float lambert = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  float rim = pow(1.0 - abs(dot(n, normalize(vToEye))), uRimPower);
  float shade = uAmbient + uDiffuse * lambert + uRimStrength * rim;
  fragColor = vec4(vColor * shade * vGlow, 1.0);
}`;

const SPRITE_VS = `#version 300 es
precision highp float;
in vec3 aPos;
in float aSize;
in vec3 aColor;
in float aGlow;
uniform mat4 uViewProj;
uniform float uYScale;
uniform float uPixelScale;
out vec3 vColor;
out float vGlow;
void main() {
  vec4 clip = uViewProj * vec4(aPos.x, aPos.y * uYScale, aPos.z, 1.0);
  gl_Position = clip;
  gl_PointSize = max(2.0, aSize * uPixelScale / max(0.2, clip.w));
  vColor = aColor;
  vGlow = aGlow;
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vGlow;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  fragColor = vec4(vColor * vGlow * a, a);
}`;

const AURA_VS = `#version 300 es
precision highp float;
in vec2 aQuad;
out vec2 vUv;
void main() { vUv = aQuad; gl_Position = vec4(aQuad, 0.999, 1.0); }`;

const AURA_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uLightAura;
uniform vec3 uShadowAura;
uniform float uTime;
uniform float uHaloFalloff;
uniform float uHaloAspect;
uniform float uSkyLight;
uniform float uSkyShadow;
uniform float uHaloStrength;
uniform float uHaloTopBoost;
uniform float uRayStrength;
uniform float uRayFrequency;
uniform float uRaySpeed;
const float HALF = 0.5;                 // sin(-1..1) -> 0..1 remap
const float SKY_BLEND_LO = -0.9;        // screen y where the shadow sky ends
const float SKY_BLEND_HI = 0.9;         // screen y where the light sky is full
const float HALO_TOP_LO = -0.2;         // where the crown boost starts
const float HALO_TOP_HI = 1.0;
out vec4 fragColor;
void main() {
  float halo = exp(-uHaloFalloff * length(vUv * vec2(1.0, uHaloAspect)));
  vec3 sky = mix(uShadowAura * uSkyShadow, uLightAura * uSkyLight, smoothstep(SKY_BLEND_LO, SKY_BLEND_HI, vUv.y));
  float rays = uRayStrength * smoothstep(0.0, 1.0, vUv.y) * (HALF + HALF * sin(vUv.x * uRayFrequency + uTime * uRaySpeed));
  vec3 c = sky
    + uLightAura * halo * (uHaloStrength + uHaloTopBoost * smoothstep(HALO_TOP_LO, HALO_TOP_HI, vUv.y))
    + uLightAura * rays;
  fragColor = vec4(c, 1.0);
}`;

/**
 * @param {WebGL2RenderingContext} gl @param {number} type @param {string} source
 * @returns {WebGLShader}
 */
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("archtree: could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown";
    gl.deleteShader(shader);
    throw new Error(`archtree: shader compile failed — ${log}`);
  }
  return shader;
}

/**
 * @param {WebGL2RenderingContext} gl @param {string} vs @param {string} fs
 * @returns {WebGLProgram}
 */
function link(gl, vs, fs) {
  const program = gl.createProgram();
  if (!program) throw new Error("archtree: could not create program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown";
    throw new Error(`archtree: program link failed — ${log}`);
  }
  return program;
}

/**
 * @param {ArchtreeParams} params
 * @returns {import("./port.js").RendererPort}
 */
export function createWebglRenderer(params) {
  /** @type {WebGL2RenderingContext|null} */
  let gl = null;
  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {Record<string, WebGLProgram>} */
  let programs = {};
  /** @type {Record<string, WebGLBuffer>} */
  let buffers = {};
  /** camera orbit state, driven from the view via the exported handles below */
  // targetY 0: the mirror axis sits in the middle of the frame, so 陽 and 陰
  // are always both in view (auto-framing below widens the distance to fit).
  const camera = { yaw: 0.6, pitch: 0.28, distance: params.cameraDistance, targetY: 0 };
  let framed = false;
  /** @type {Float32Array} */
  let viewProj = identity();
  /** @type {Array<{id: string, x: number, y: number, z: number}>} */
  let pickPoints = [];
  let branchCount = 0;
  let spriteCount = 0;

  /** @param {string} name @param {number} size @param {Float32Array} data @param {WebGLProgram} program */
  const attrib = (name, size, data, program) => {
    if (!gl) return;
    const key = `${name}:${program === programs.branch ? "b" : "s"}`;
    let buffer = buffers[key];
    if (!buffer) {
      const created = gl.createBuffer();
      if (!created) throw new Error("archtree: could not create buffer");
      buffers[key] = created;
      buffer = created;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(program, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };

  /** Geometry rebuilt on every update — the scene is small and the model is the truth. */
  /** @type {{branch: Record<string, Float32Array>, sprite: Record<string, Float32Array>}} */
  let geometry = { branch: {}, sprite: {} };

  /**
   * @param {ArchtreeModel} model @param {ArchtreeLayout} layout @param {number} timeMs
   * @param {HalfTheme} half material language of the half being built
   * @param {HalfTheme} otherHalf the half on the other side of the mirror axis —
   *   needed for the seam blend: both halves must arrive at the SAME emitted
   *   colour at y=0, otherwise the material difference is a hard step there.
   */
  const buildGeometry = (model, layout, timeMs, half, otherHalf) => {
    const nodes = model.nodes;
    /** @type {Map<string, import("./model.js").ArchtreeNode>} */
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const segs = layout.segments;
    const verts = segs.length * 6;

    const pos = new Float32Array(verts * 3);
    const other = new Float32Array(verts * 3);
    const side = new Float32Array(verts);
    const flip = new Float32Array(verts);
    const radius = new Float32Array(verts);
    const color = new Float32Array(verts * 3);
    const glow = new Float32Array(verts);

    /**
     * Bark near the root, status colour near the tip — evaluated PER ENDPOINT so
     * the colour runs continuously along a segment and across a fork instead of
     * jumping at every joint (the visible "facet" break was partly this).
     * @param {import("./theme.js").HalfTheme} theme
     * @param {number} depth @param {import("./model.js").ArchtreeStatus} status
     * @returns {[number, number, number]}
     */
    const barkBlend = (theme, depth, status) => {
      const light = statusColor(theme, status);
      const t = Math.min(1, (depth / Math.max(1, model.maxDepth)) * (1 + params.branchTipBias));
      return [
        theme.bark[0] * (1 - t) + light[0] * t,
        theme.bark[1] * (1 - t) + light[1] * t,
        theme.bark[2] * (1 - t) + light[2] * t,
      ];
    };

    /**
     * Emissive weight of a branch in one half: status glow, withered by age,
     * lifted off zero by the glow floor.
     * @param {HalfTheme} theme @param {import("./model.js").ArchtreeStatus} status @param {number} witherT
     * @returns {number}
     */
    const branchGlow = (theme, status, witherT) => {
      const g = statusGlow(theme, status);
      const residual = params.witherResidualGlow;
      const gRaw = status === "dead" ? g * (residual + (1 - residual) * (1 - witherT)) : g;
      // wood is lit, not emissive: the status glow rides ON TOP of a floor, so a
      // dull status can never multiply a branch down to a black silhouette
      return params.branchGlowFloor + (1 - params.branchGlowFloor) * gRaw;
    };

    // Seam blend width in world units. Inside it, the emitted colour of BOTH
    // halves is pulled towards their common mean, reaching it exactly at y=0 —
    // so 陽→陰 reads as a gradient down the trunk instead of a cut.
    const seamSpan = params.trunkHeight * params.mirrorSeamSpanFactor;

    let v = 0;
    for (const seg of segs) {
      const node = nodeById.get(seg.to.id);
      const status = node ? node.status : "idle";
      const parent = nodeById.get(seg.from.id);
      const rgbTo = barkBlend(half, node ? node.depth : 0, status);
      const rgbFrom = parent ? barkBlend(half, parent.depth, parent.status) : [...half.bark];
      // wither crawl: a freshly dead branch blackens from tip to root
      const witherAge = status === "dead" && node ? timeMs - node.lastActivity : Number.POSITIVE_INFINITY;
      const witherT = Math.max(0, Math.min(1, witherAge / params.witherAnimMs));
      const gWithered = branchGlow(half, status, witherT);
      // the same segment as the OTHER half would emit it — the seam target
      const otherTo = barkBlend(otherHalf, node ? node.depth : 0, status);
      const otherFrom = parent ? barkBlend(otherHalf, parent.depth, parent.status) : [...otherHalf.bark];
      const gOther = branchGlow(otherHalf, status, witherT);

      /**
       * @param {import("./layout.js").ArchtreePoint} p @param {import("./layout.js").ArchtreePoint} q
       * @param {number} s @param {number[]} rgb colour of the endpoint p
       * @param {number} f +1 when p is the segment start, -1 when it is the end
       * @param {number[]} rgbOther the other half's colour of the same endpoint
       */
      const push = (p, q, s, rgb, f, rgbOther) => {
        pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
        other[v * 3] = q.x; other[v * 3 + 1] = q.y; other[v * 3 + 2] = q.z;
        side[v] = s;
        flip[v] = f;
        radius[v] = p.thickness;
        // The fragment shader emits vColor * shade * vGlow, so colour and glow
        // only ever act as one product. The seam blend is done on that product
        // and baked into the colour; vGlow stays 1 so nothing can re-scale it
        // after the blend and re-open the step.
        const seamT = seamSpan > 0 ? Math.min(1, Math.abs(p.y) / seamSpan) : 1;
        for (let c = 0; c < 3; c += 1) {
          const own = rgb[c] * gWithered;
          const seam = (own + rgbOther[c] * gOther) / 2;
          color[v * 3 + c] = seam + (own - seam) * seamT;
        }
        glow[v] = 1;
        v += 1;
      };
      push(seg.from, seg.to, -1, rgbFrom, 1, otherFrom);
      push(seg.from, seg.to, 1, rgbFrom, 1, otherFrom);
      push(seg.to, seg.from, -1, rgbTo, -1, otherTo);
      push(seg.to, seg.from, -1, rgbTo, -1, otherTo);
      push(seg.from, seg.to, 1, rgbFrom, 1, otherFrom);
      push(seg.to, seg.from, 1, rgbTo, -1, otherTo);
    }
    branchCount = v;

    // leaves + motes: a CLUSTER of glowing sprites per node (a single sprite
    // vanished at overview distance — measured in screenshots/before/), plus
    // drifting particles whose count follows the node's status.
    /** @param {import("./model.js").ArchtreeStatus} status @returns {number} */
    const moteCountOf = (status) => {
      const rate =
        status === "active" ? params.moteRateActive
        : status === "done" ? params.moteRateDone
        : status === "dead" ? params.moteRateDead
        : params.moteRateIdle;
      return Math.round(params.motesPerNode * rate);
    };
    const leavesPerNode = Math.max(1, params.leafClusterCount);
    let moteTotal = 0;
    for (const node of nodes) moteTotal += moteCountOf(node.status);
    const spriteTotal = nodes.length * leavesPerNode + moteTotal;
    const sPos = new Float32Array(spriteTotal * 3);
    const sSize = new Float32Array(spriteTotal);
    const sColor = new Float32Array(spriteTotal * 3);
    const sGlow = new Float32Array(spriteTotal);
    let s = 0;
    for (const node of nodes) {
      const point = layout.points.get(node.id);
      if (!point) continue;
      const rgb = statusColor(half, node.status);
      const pulse =
        node.status === "active" ? 1 + params.leafPulseAmp * Math.sin(timeMs / params.leafPulseMs + node.depth) : 1;
      const baseSize = params.leafScale * Math.pow(params.leafFalloff, node.depth) * pulse * params.leafPixelScale;
      const glowValue = statusGlow(half, node.status);
      for (let i = 0; i < leavesPerNode; i += 1) {
        // deterministic sphere-ish scatter: golden angle around the node, radius
        // from a per-node hash, so a cluster is stable across frames
        const angle = i * GOLDEN_ANGLE + hash01(node.id, i) * Math.PI;
        const radial = params.leafClusterRadius * Math.sqrt((i + 1) / leavesPerNode);
        const sway = Math.sin(timeMs / params.leafClusterSwayMs + angle) * params.leafClusterSwayAmp;
        sPos[s * 3] = point.x + Math.cos(angle) * radial + sway;
        sPos[s * 3 + 1] = point.y + params.leafClusterRise * (hash01(node.id, i + leavesPerNode) - 0.5) * 2;
        sPos[s * 3 + 2] = point.z + Math.sin(angle) * radial + sway;
        sSize[s] = baseSize * (1 - params.leafClusterSizeJitter * hash01(node.id, i));
        sColor[s * 3] = rgb[0]; sColor[s * 3 + 1] = rgb[1]; sColor[s * 3 + 2] = rgb[2];
        sGlow[s] = glowValue;
        s += 1;
      }
    }
    for (const node of nodes) {
      const point = layout.points.get(node.id);
      if (!point) continue;
      const motes = moteCountOf(node.status);
      if (motes <= 0) continue;
      for (let i = 0; i < motes; i += 1) {
        const phase = (timeMs / params.moteCycleMs + i / motes + hash01(node.id, i)) % 1;
        // 陽 sparks rise, 陰 ash falls — the direction is the half's material
        // language (theme.moteRise), not a second code path
        const travel = phase * params.moteTravel * half.moteRise;
        const swirl = i * MOTE_SWIRL_STEP + timeMs / params.moteSwirlMs;
        sPos[s * 3] = point.x + Math.cos(swirl) * params.moteSwirlRadius;
        sPos[s * 3 + 1] = point.y + travel;
        sPos[s * 3 + 2] = point.z + Math.sin(swirl) * params.moteSwirlRadius;
        sSize[s] = params.moteSizePx * (1 - phase);
        sColor[s * 3] = half.mote[0]; sColor[s * 3 + 1] = half.mote[1]; sColor[s * 3 + 2] = half.mote[2];
        sGlow[s] = params.moteGlow * (1 - phase);
        s += 1;
      }
    }
    spriteCount = s;

    geometry = {
      branch: { aPos: pos, aOther: other, aSide: side, aFlip: flip, aRadius: radius, aColor: color, aGlow: glow },
      sprite: { aPos: sPos, aSize: sSize, aColor: sColor, aGlow: sGlow },
    };

    pickPoints = nodes.map((node) => {
      const point = layout.points.get(node.id);
      return { id: node.id, x: point?.x ?? 0, y: point?.y ?? 0, z: point?.z ?? 0 };
    });
  };

  /** @param {HalfTheme} theme @param {number} yScale */
  const drawHalf = (theme, yScale) => {
    if (!gl || !canvas) return;
    const eye = [
      Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
      Math.sin(camera.pitch) * camera.distance + camera.targetY,
      Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
    ];
    // branches
    const branch = programs.branch;
    gl.useProgram(branch);
    for (const [name, data] of Object.entries(geometry.branch)) {
      attrib(name, name === "aPos" || name === "aOther" || name === "aColor" ? 3 : 1, data, branch);
    }
    gl.uniformMatrix4fv(gl.getUniformLocation(branch, "uViewProj"), false, viewProj);
    gl.uniform3f(gl.getUniformLocation(branch, "uEye"), eye[0], eye[1], eye[2]);
    gl.uniform1f(gl.getUniformLocation(branch, "uYScale"), yScale);
    gl.uniform1f(gl.getUniformLocation(branch, "uQuarterTurn"), QUARTER_TURN);
    gl.uniform3f(
      gl.getUniformLocation(branch, "uLightDir"),
      params.branchLightX,
      // the key light follows the half: the shadow tree is lit from below,
      // otherwise the mirrored geometry would read as a lighting error
      params.branchLightY * Math.sign(yScale || 1),
      params.branchLightZ,
    );
    gl.uniform1f(gl.getUniformLocation(branch, "uAmbient"), params.branchAmbient);
    gl.uniform1f(gl.getUniformLocation(branch, "uDiffuse"), params.branchDiffuse);
    gl.uniform1f(gl.getUniformLocation(branch, "uRimStrength"), params.branchRimStrength);
    gl.uniform1f(gl.getUniformLocation(branch, "uRimPower"), params.branchRimPower);
    // shadow half re-tints via a colour multiply done on the CPU-free path:
    // the fragment shader multiplies by vGlow, so a dimmer half simply gets a
    // smaller uYScale-paired glow — encoded by the theme's glow factor.
    gl.drawArrays(gl.TRIANGLES, 0, branchCount);

    // leaves / motes
    const sprite = programs.sprite;
    gl.useProgram(sprite);
    for (const [name, data] of Object.entries(geometry.sprite)) {
      attrib(name, name === "aPos" || name === "aColor" ? 3 : 1, data, sprite);
    }
    gl.uniformMatrix4fv(gl.getUniformLocation(sprite, "uViewProj"), false, viewProj);
    gl.uniform1f(gl.getUniformLocation(sprite, "uYScale"), yScale);
    gl.uniform1f(
      gl.getUniformLocation(sprite, "uPixelScale"),
      (canvas.height / params.spritePixelRef) * (theme.moteRise > 0 ? 1 : params.shadowSpriteScale),
    );
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, spriteCount);
    gl.disable(gl.BLEND);
  };

  return {
    /** @param {HTMLCanvasElement} target */
    mount(target) {
      canvas = target;
      const context = target.getContext("webgl2", { antialias: true, alpha: false });
      if (!context) throw new Error("archtree: WebGL2 is unavailable in this browser");
      gl = context;
      programs = {
        branch: link(gl, BRANCH_VS, BRANCH_FS),
        sprite: link(gl, SPRITE_VS, SPRITE_FS),
        aura: link(gl, AURA_VS, AURA_FS),
      };
      const quad = gl.createBuffer();
      if (!quad) throw new Error("archtree: could not create buffer");
      buffers.aura = quad;
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enable(gl.DEPTH_TEST);
    },

    /**
     * @param {ArchtreeModel} model @param {ArchtreeLayout} layout @param {number} timeMs
     */
    update(model, layout, timeMs) {
      if (!gl || !canvas) return;
      const width = Math.max(1, canvas.clientWidth | 0);
      const height = Math.max(1, canvas.clientHeight | 0);
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(BACKDROP[0], BACKDROP[1], BACKDROP[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // aura backdrop (drawn once, spans both halves)
      const aura = programs.aura;
      gl.useProgram(aura);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.aura);
      const quadLoc = gl.getAttribLocation(aura, "aQuad");
      gl.enableVertexAttribArray(quadLoc);
      gl.vertexAttribPointer(quadLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3f(gl.getUniformLocation(aura, "uLightAura"), ...LIGHT_THEME.aura);
      gl.uniform3f(gl.getUniformLocation(aura, "uShadowAura"), ...SHADOW_THEME.aura);
      gl.uniform1f(gl.getUniformLocation(aura, "uTime"), timeMs / MS_PER_SECOND);
      gl.uniform1f(gl.getUniformLocation(aura, "uHaloFalloff"), params.auraHaloFalloff);
      gl.uniform1f(gl.getUniformLocation(aura, "uHaloAspect"), params.auraHaloAspect);
      gl.uniform1f(gl.getUniformLocation(aura, "uSkyLight"), params.auraSkyLight);
      gl.uniform1f(gl.getUniformLocation(aura, "uSkyShadow"), params.auraSkyShadow);
      gl.uniform1f(gl.getUniformLocation(aura, "uHaloStrength"), params.auraHaloStrength);
      gl.uniform1f(gl.getUniformLocation(aura, "uHaloTopBoost"), params.auraHaloTopBoost);
      gl.uniform1f(gl.getUniformLocation(aura, "uRayStrength"), params.auraRayStrength);
      gl.uniform1f(gl.getUniformLocation(aura, "uRayFrequency"), params.auraRayFrequency);
      gl.uniform1f(gl.getUniformLocation(aura, "uRaySpeed"), params.auraRaySpeed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // first frame: pull the camera back until crown AND mirrored roots fit
      if (!framed && layout.points.size > 0) {
        let extent = 0;
        for (const point of layout.points.values()) {
          extent = Math.max(extent, Math.abs(point.y), Math.hypot(point.x, point.z));
        }
        const halfFov = (params.cameraFov * Math.PI) / 360;
        camera.distance = (extent / Math.tan(halfFov)) * params.cameraFramePad;
        framed = true;
      }
      camera.distance = Math.max(2, camera.distance);
      const eye = [
        Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
        Math.sin(camera.pitch) * camera.distance + camera.targetY,
        Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.distance,
      ];
      viewProj = multiply(
        perspective(params.cameraFov, canvas.width / canvas.height, params.cameraNear, params.cameraFar),
        lookAt(eye, [0, camera.targetY, 0], [0, 1, 0]),
      );

      // Each half gets its own geometry pass: the shadow tree is the same
      // silhouette read with the inverted material language (ash bark, blood
      // glow on the dead), not a re-tint of the light half's colours.
      buildGeometry(model, layout, timeMs, LIGHT_THEME, SHADOW_THEME);
      drawHalf(LIGHT_THEME, 1);
      buildGeometry(model, layout, timeMs, SHADOW_THEME, LIGHT_THEME);
      drawHalf(SHADOW_THEME, -params.shadowMirror);
    },

    /**
     * @param {number} x @param {number} y
     * @returns {string|null}
     */
    pick(x, y) {
      if (!canvas || pickPoints.length === 0) return null;
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      let best = null;
      let bestDist = params.pickRadiusPx; // a miss must stay a miss
      for (const point of pickPoints) {
        const clip = [
          viewProj[0] * point.x + viewProj[4] * point.y + viewProj[8] * point.z + viewProj[12],
          viewProj[1] * point.x + viewProj[5] * point.y + viewProj[9] * point.z + viewProj[13],
          viewProj[3] * point.x + viewProj[7] * point.y + viewProj[11] * point.z + viewProj[15],
        ];
        if (clip[2] <= 0) continue;
        const sx = ((clip[0] / clip[2]) * NDC_TO_UNIT_SCALE + NDC_TO_UNIT_OFFSET) * width;
        const sy = (1 - ((clip[1] / clip[2]) * NDC_TO_UNIT_SCALE + NDC_TO_UNIT_OFFSET)) * height;
        const dist = Math.hypot(sx - x, sy - y);
        if (dist < bestDist) {
          bestDist = dist;
          best = point.id;
        }
      }
      return best;
    },

    dispose() {
      if (!gl) return;
      for (const program of Object.values(programs)) gl.deleteProgram(program);
      for (const buffer of Object.values(buffers)) gl.deleteBuffer(buffer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      programs = {};
      buffers = {};
      gl = null;
      canvas = null;
    },

    // camera handles used by the view's pointer/keyboard bindings
    camera,
  };
}

registerRenderer("webgl2", createWebglRenderer);
