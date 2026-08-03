/**
 * client/kernel/tileset.js — tileset SKINS for the walkable world.
 *
 * The concept doc's rule: the world is semantic tags; a tileset is just a
 * tag→image lookup. Swapping the skin changes nothing about the world.
 *
 * Skins:
 *  - 'gloom' (default) — AI-painted textures streamed from GET /art/tile/<tag>
 *    (server-side cache; pollinations online, flat SVG offline). Until a texture
 *    arrives the flat painter shows instantly, so the map never blocks.
 *  - 'flat'  — deterministic flat colors + hash speckle. Fully offline.
 *
 * Pick with localStorage 'ttrpg_tileset' = 'gloom' | 'flat'.
 * Add a skin: one entry in SKINS. Zero gameplay logic here — presentation only.
 */

const FALLBACK_COLORS = {
  floor: '#4a4440', grass: '#2e4230', sand: '#5a5343', wall: '#2b2b31',
  rock: '#33302e', tree: '#1d3020', water: '#1d2f45', road: '#54483a',
  rubble: '#3e3a37', door: '#5e4426', void: '#0a0a0c',
};

/** Cheap deterministic hash for speckle patterns. */
function h2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Flat painter: color + a whisper of deterministic speckle so tiles read. */
function drawFlat(ctx, tag, px, py, size, tx, ty) {
  ctx.fillStyle = FALLBACK_COLORS[tag] || '#333';
  ctx.fillRect(px, py, size, size);
  const n = h2(tx, ty);
  ctx.fillStyle = `rgba(255,255,255,${(0.02 + n * 0.04).toFixed(3)})`;
  ctx.fillRect(px + (n * size) | 0, py + (h2(ty, tx) * size) | 0, 2, 2);
  if (tag === 'tree') {
    ctx.fillStyle = 'rgba(10,26,14,0.8)';
    ctx.beginPath();
    ctx.arc(px + size / 2, py + size / 2, size * 0.36, 0, Math.PI * 2);
    ctx.fill();
  }
  if (tag === 'wall' || tag === 'rock') {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
  }
  if (tag === 'water') {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(px, py + ((ty % 3) * size / 3) | 0, size, 1);
  }
  if (tag === 'door') {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(px + size * 0.25, py + size * 0.15, size * 0.5, size * 0.7);
  }
}

export function createTileset(name, { serverBase, onReady } = {}) {
  const skin = name === 'flat' ? 'flat' : 'gloom';
  const images = new Map(); // tag → HTMLImageElement (loaded) | 'failed'

  function imageFor(tag) {
    if (skin === 'flat') return null;
    const got = images.get(tag);
    if (got === 'failed') return null;
    if (got) return got.complete && got.naturalWidth ? got : null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // v param: bump to bust browser caches when tile prompts change.
    img.src = `${serverBase}/art/tile/${encodeURIComponent(tag)}?v=2`;
    img.onload = () => { if (typeof onReady === 'function') onReady(); };
    // Failures retry after a beat — the server generates tiles through a
    // rate-limited queue, so the texture may simply not be ready yet.
    img.onerror = () => {
      images.set(tag, 'failed');
      setTimeout(() => {
        if (images.get(tag) === 'failed') {
          images.delete(tag);
          if (typeof onReady === 'function') onReady(); // repaint → re-request
        }
      }, 10_000);
    };
    images.set(tag, img);
    return null;
  }

  return {
    name: skin,
    /** Draw one tile. Always paints instantly (flat), upgrades to texture when loaded. */
    draw(ctx, tag, px, py, size, tx, ty) {
      const img = imageFor(tag);
      if (img) {
        ctx.drawImage(img, px, py, size, size);
        // Legibility pass: AI textures are painterly and same-ish in luminance —
        // solid/elevated tags get a dark treatment so the layout still READS.
        if (tag === 'wall' || tag === 'rock') {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(px, py, size, size);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
        } else if (tag === 'tree') {
          ctx.fillStyle = 'rgba(6,18,8,0.5)';
          ctx.beginPath();
          ctx.arc(px + size / 2, py + size / 2, size * 0.42, 0, Math.PI * 2);
          ctx.fill();
        } else if (tag === 'water') {
          ctx.fillStyle = 'rgba(20,45,90,0.35)';
          ctx.fillRect(px, py, size, size);
        } else if (tag === 'door') {
          ctx.strokeStyle = 'rgba(220,170,80,0.5)';
          ctx.strokeRect(px + 1, py + 1, size - 2, size - 2);
        }
      } else {
        drawFlat(ctx, tag, px, py, size, tx, ty);
      }
    },
  };
}

export function activeTilesetName() {
  try { return localStorage.getItem('ttrpg_tileset') || 'gloom'; } catch { return 'gloom'; }
}
