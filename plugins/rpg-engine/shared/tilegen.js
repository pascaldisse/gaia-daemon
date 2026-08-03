/**
 * shared/tilegen.js — PURE deterministic per-location tile maps (the walkable world).
 *
 * The concept doc's "world as abstract semantic data": every location gets a
 * grid of semantic TAGS (floor/wall/water/tree/…), exit markers wired to its
 * place.connections, and spawn points for whatever stands there. A tileset is
 * just a skin that maps tags → images — swapping it changes NOTHING about the
 * world (see client/kernel/tileset.js).
 *
 * Guarantees (procgen owns structure):
 *   - every exit is reachable from the center (paths are carved, then verified)
 *   - exits correspond 1:1 to place.connections, deterministically placed
 *   - same location id + seed ⇒ byte-identical grid (safe to backfill at boot)
 *
 * PURE: no imports from server/ or client/, no fs, no Date, no Math.random.
 */

import { makeRng } from './rng.js';

// ---- the semantic tag vocabulary (tilesets bind to THESE, not to chars) ----

export const TILE_TAGS = {
  '.': 'floor',
  ',': 'grass',
  ':': 'sand',
  '#': 'wall',
  'R': 'rock',
  'T': 'tree',
  '~': 'water',
  '=': 'road',
  '%': 'rubble',
  '+': 'door',
  ' ': 'void',
};

export const WALKABLE = new Set(['floor', 'grass', 'sand', 'road', 'rubble', 'door']);

export const GRID_W = 28;
export const GRID_H = 16;

/** FNV-1a string hash → uint32 (deterministic per-location rng seed). */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---- grid helpers ----------------------------------------------------------

const mkGrid = (fill) => Array.from({ length: GRID_H }, () => Array(GRID_W).fill(fill));
const inGrid = (x, y) => x >= 0 && x < GRID_W && y >= 0 && y < GRID_H;

/** Carve a straight-ish corridor of `char` from (x0,y0) to (x1,y1), L-shaped. */
function carvePath(g, x0, y0, x1, y1, char, wide = false) {
  let x = x0, y = y0;
  const put = (px, py) => {
    if (inGrid(px, py)) g[py][px] = char;
    if (wide && inGrid(px + 1, py)) g[py][px + 1] = char;
  };
  while (x !== x1) { put(x, y); x += Math.sign(x1 - x); }
  while (y !== y1) { put(x, y); y += Math.sign(y1 - y); }
  put(x1, y1);
}

/** Sprinkle `char` over cells currently equal to `on`, with probability p. */
function sprinkle(g, rng, char, on, p) {
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (g[y][x] === on && rng.next() < p) g[y][x] = char;
    }
  }
}

/** Stamp a blob (rough ellipse) of `char` centered at (cx,cy). */
function blob(g, rng, cx, cy, rx, ry, char) {
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      if (!inGrid(x, y)) continue;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1 + (rng.next() - 0.5) * 0.4) g[y][x] = char;
    }
  }
}

// ---- exit placement ---------------------------------------------------------

/**
 * Deterministic edge point for an exit: which side + offset comes from the
 * TARGET id hash, so the same door sits in the same wall on every boot.
 */
function exitPoint(targetId, index) {
  const h = hashStr(targetId);
  const side = (h + index) % 4; // 0 N, 1 E, 2 S, 3 W
  const t = 0.25 + ((h >>> 4) % 51) / 100; // 0.25..0.75 along the edge
  if (side === 0) return { x: Math.floor(GRID_W * t), y: 0 };
  if (side === 2) return { x: Math.floor(GRID_W * t), y: GRID_H - 1 };
  if (side === 1) return { x: GRID_W - 1, y: Math.floor(GRID_H * t) };
  return { x: 0, y: Math.floor(GRID_H * t) };
}

// ---- styles ------------------------------------------------------------------

/** Outdoor settlement: grass, a road plaza, buildings with doors, trees. */
function styleSettlement(g, rng) {
  for (const row of g) row.fill(',');
  const cx = GRID_W >> 1, cy = GRID_H >> 1;
  blob(g, rng, cx, cy, 5, 3, '=');
  const houses = 2 + rng.int(0, 2);
  for (let i = 0; i < houses; i++) {
    const w = 4 + rng.int(0, 3), h = 3 + rng.int(0, 2);
    const hx = 2 + rng.int(0, GRID_W - w - 4), hy = 1 + rng.int(0, GRID_H - h - 3);
    if (Math.abs(hx + w / 2 - cx) < 4 && Math.abs(hy + h / 2 - cy) < 3) continue; // keep the plaza open
    for (let y = hy; y < hy + h; y++) {
      for (let x = hx; x < hx + w; x++) {
        g[y][x] = (y === hy || y === hy + h - 1 || x === hx || x === hx + w - 1) ? '#' : '.';
      }
    }
    g[hy + h - 1][hx + 1 + rng.int(0, w - 3)] = '+'; // a door in the south wall
  }
  sprinkle(g, rng, 'T', ',', 0.045);
  return { base: ',' };
}

/** Untamed wilds: grass, tree stands, a water blob, a dirt track. */
function styleWilds(g, rng) {
  for (const row of g) row.fill(',');
  sprinkle(g, rng, 'T', ',', 0.16);
  blob(g, rng, 4 + rng.int(0, GRID_W - 9), 3 + rng.int(0, GRID_H - 7), 3 + rng.int(0, 2), 2, '~');
  sprinkle(g, rng, 'R', ',', 0.03);
  return { base: ',' };
}

/** Dungeon: solid rock, carved rooms + corridors, rubble. */
function styleDungeon(g, rng) {
  for (const row of g) row.fill('R');
  const rooms = [];
  const n = 3 + rng.int(0, 2);
  for (let i = 0; i < n; i++) {
    const w = 4 + rng.int(0, 4), h = 3 + rng.int(0, 3);
    const x = 1 + rng.int(0, GRID_W - w - 2), y = 1 + rng.int(0, GRID_H - h - 2);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) g[yy][xx] = '.';
    rooms.push({ cx: x + (w >> 1), cy: y + (h >> 1) });
  }
  for (let i = 1; i < rooms.length; i++) {
    carvePath(g, rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy, '.');
  }
  sprinkle(g, rng, '%', '.', 0.05);
  return { base: '.' };
}

/** Landmark: open ground with a central feature (standing stones). */
function styleLandmark(g, rng) {
  for (const row of g) row.fill(':');
  const cx = GRID_W >> 1, cy = GRID_H >> 1;
  for (let a = 0; a < 8; a++) {
    const x = cx + Math.round(Math.cos(a * Math.PI / 4) * 4);
    const y = cy + Math.round(Math.sin(a * Math.PI / 4) * 3);
    if (inGrid(x, y)) g[y][x] = 'R';
  }
  sprinkle(g, rng, ',', ':', 0.25);
  sprinkle(g, rng, 'T', ',', 0.05);
  return { base: ':' };
}

/** Interior: one big room (walls all around), pillars, floor. */
function styleInterior(g, rng) {
  for (const row of g) row.fill('.');
  for (let x = 0; x < GRID_W; x++) { g[0][x] = '#'; g[GRID_H - 1][x] = '#'; }
  for (let y = 0; y < GRID_H; y++) { g[y][0] = '#'; g[y][GRID_W - 1] = '#'; }
  const pillars = 2 + rng.int(0, 3);
  for (let i = 0; i < pillars; i++) {
    const x = 4 + rng.int(0, GRID_W - 9), y = 3 + rng.int(0, GRID_H - 7);
    g[y][x] = '#';
  }
  return { base: '.', walled: true };
}

const STYLES = {
  settlement: styleSettlement,
  entrance: styleSettlement,
  wilds: styleWilds,
  dungeon: styleDungeon,
  lair: styleDungeon,
  landmark: styleLandmark,
  interior: styleInterior,
  location: styleWilds,
};

/** Keyword heuristic for authored scenes that don't declare flags.mapStyle. */
const INTERIOR_RE = /\b(chapel|church|inn|tavern|gasthaus|mühle|mill|hall|house|room|shop|store|vault|crypt|cellar|tower|temple|cave|mine|library|court)\b/i;
export function inferStyle(locEntity) {
  const declared = locEntity.flags && locEntity.flags.mapStyle;
  if (declared && STYLES[declared]) return declared;
  const text = `${locEntity.identity?.name || ''} ${locEntity.identity?.description || ''}`;
  if (INTERIOR_RE.test(text)) return 'interior';
  if (/\b(forest|wood|marsh|swamp|reef|shore|coast|wild|heath|fen|mire|gulch|path|trail)\b/i.test(text)) return 'wilds';
  if (/\b(square|market|village|town|street|strip|harbor|wharf|dock|plaza)\b/i.test(text)) return 'settlement';
  return 'wilds';
}

// ---- connectivity repair -----------------------------------------------------

/** BFS over walkable tiles from (x,y); returns the visited set as "x,y" keys. */
function flood(g, x0, y0) {
  const seen = new Set();
  const queue = [[x0, y0]];
  const walkable = (x, y) => inGrid(x, y) && WALKABLE.has(TILE_TAGS[g[y][x]]);
  if (!walkable(x0, y0)) return seen;
  seen.add(`${x0},${y0}`);
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (walkable(nx, ny) && !seen.has(`${nx},${ny}`)) {
        seen.add(`${nx},${ny}`);
        queue.push([nx, ny]);
      }
    }
  }
  return seen;
}

// ---- exported generator --------------------------------------------------------

/**
 * Generate the tiles component for one location.
 *
 * @param {string} locId — entity id (drives the deterministic rng)
 * @param {object} locEntity — the location's components (connections, flags, identity)
 * @param {object} [opts]
 *   @param {number} [opts.seed=42]  — world seed, XORed with the location hash
 *   @param {string} [opts.style]    — explicit style; else flags.mapStyle, else inferred
 *   @param {string[]} [opts.presentIds] — co-located entity ids to give spawn points
 * @returns {{w:number,h:number,rows:string[],legend:object,exits:Array,spawns:object,style:string}}
 */
export function generateTiles(locId, locEntity, opts = {}) {
  const seed = (opts.seed ?? 42) >>> 0;
  const rng = makeRng((hashStr(locId) ^ seed) >>> 0);
  const style = opts.style || inferStyle(locEntity);
  const g = mkGrid('.');
  const styleInfo = (STYLES[style] || styleWilds)(g, rng);

  const cx = GRID_W >> 1, cy = GRID_H >> 1;
  // The center is always standable — the avatar's default spawn.
  g[cy][cx] = styleInfo.base === ',' ? ',' : '.';

  // Exits: one per connection, deterministic edge point, path carved to center.
  const connections = (locEntity.place && locEntity.place.connections) || [];
  const exits = [];
  const used = new Set();
  connections.forEach((conn, i) => {
    let { x, y } = exitPoint(conn.targetId, i);
    while (used.has(`${x},${y}`)) x = (x + 2) % GRID_W; // no two exits share a tile
    used.add(`${x},${y}`);
    // In walled interiors the exit is a door IN the wall; outdoors it's road.
    g[y][x] = styleInfo.walled ? '+' : '=';
    // Carve an approach from just inside the exit to the center.
    const ix = x === 0 ? 1 : x === GRID_W - 1 ? GRID_W - 2 : x;
    const iy = y === 0 ? 1 : y === GRID_H - 1 ? GRID_H - 2 : y;
    carvePath(g, ix, iy, cx, cy, styleInfo.walled ? '.' : '=');
    exits.push({ x, y, targetId: conn.targetId });
  });

  // Spawn points: co-located entities ring the center on walkable tiles.
  const spawns = {};
  (opts.presentIds || []).forEach((id, i) => {
    const angle = (hashStr(id) % 360) * Math.PI / 180;
    for (let r = 2 + (i % 4); r < Math.max(GRID_W, GRID_H); r++) {
      const x = Math.round(cx + Math.cos(angle) * r);
      const y = Math.round(cy + Math.sin(angle) * r * 0.6);
      if (inGrid(x, y) && WALKABLE.has(TILE_TAGS[g[y][x]]) && !Object.values(spawns).some(s => s.x === x && s.y === y)) {
        spawns[id] = { x, y };
        break;
      }
    }
    if (!spawns[id]) spawns[id] = { x: cx + 1, y: cy };
  });

  // Connectivity repair: every exit must reach the center. If a carve got
  // overwritten (shouldn't happen, but procgen humility), carve again straight.
  const reach = flood(g, cx, cy);
  for (const e of exits) {
    const ix = e.x === 0 ? 1 : e.x === GRID_W - 1 ? GRID_W - 2 : e.x;
    const iy = e.y === 0 ? 1 : e.y === GRID_H - 1 ? GRID_H - 2 : e.y;
    if (!reach.has(`${ix},${iy}`)) carvePath(g, ix, iy, cx, cy, '.');
  }

  return {
    w: GRID_W,
    h: GRID_H,
    rows: g.map(row => row.join('')),
    legend: { ...TILE_TAGS },
    exits,
    spawns,
    style,
  };
}

/**
 * Backfill: give every location in an entity map a tiles component (skips those
 * that already have one — authored grids win). Deterministic per (locId, seed).
 *
 * @param {Map<string,object>|Record<string,object>} entities
 * @param {number} [seed=42]
 * @returns {number} how many locations were backfilled
 */
export function backfillTiles(entities, seed = 42) {
  const isMap = typeof entities.get === 'function';
  const all = isMap ? [...entities.entries()] : Object.entries(entities);
  const locs = all.filter(([_, c]) => c.identity && c.identity.kind === 'location');
  let count = 0;
  for (const [locId, comps] of locs) {
    if (comps.tiles) continue;
    const presentIds = all
      .filter(([id, c]) => id !== locId && c.place && c.place.locationId === locId && c.identity && c.identity.kind !== 'location')
      .map(([id]) => id)
      .sort();
    comps.tiles = generateTiles(locId, comps, { seed, presentIds });
    count++;
  }
  return count;
}
