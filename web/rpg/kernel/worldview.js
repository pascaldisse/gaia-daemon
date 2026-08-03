/**
 * client/kernel/worldview.js — the walkable world (canvas) + the world map.
 *
 * The dream layer: every location's semantic tile grid rendered through a
 * swappable tileset skin, with a point-click avatar. Walking onto an EXIT
 * travels (the real `move` op — same pipeline as typing "go north"); clicking
 * an NPC walks adjacent and prefills "@Name "; clicking an ENEMY walks
 * adjacent and sends "attack <name>" — the JRPG handoff into the existing
 * turn-based combat view. The map layer is PRESENTATION + traversal only:
 * combat, checks, and canon never live here.
 *
 * Expansion seam: `onStep(locId, x, y, tag)` fires on every avatar step —
 * hang random encounters, traps, or footstep audio there later.
 *
 * Multiplayer: party members at the same location appear at their spawn
 * points; your avatar is the gold one.
 */

import { createTileset, activeTilesetName } from './tileset.js';

const WALKABLE = new Set(['floor', 'grass', 'sand', 'road', 'rubble', 'door']);
const STEP_MS = 110; // avatar ms per tile

export class WorldView {
  /**
   * @param {object} opts
   * @param {object} opts.store — the entity store mirror
   * @param {(text:string, move?:string, target?:string, zone?:string)=>void} opts.onAction
   * @param {string} opts.serverBase — e.g. "http://localhost:8420"
   */
  constructor({ store, onAction, serverBase }) {
    this.store = store;
    this.onAction = onAction;
    this.serverBase = serverBase;
    this.tileset = createTileset(activeTilesetName(), {
      serverBase,
      onReady: () => this._dirty(),
    });
    this.onStep = null; // expansion seam: (locId, x, y, tag) per avatar step

    this.locId = null;
    this.grid = null;      // rows of tags
    this.exits = [];
    this.spawns = {};
    this.avatar = null;    // {x, y} tile coords (float during animation)
    this.path = [];        // queued steps [{x,y}]
    this.pending = null;   // action fired on arrival {type:'exit'|'attack'|'talk', ...}
    this.canvas = null;
    this.wrap = null;
    this._raf = null;
    this._lastTs = 0;
    this._travelSent = false;
  }

  // ---- mounting ----

  /**
   * Mount (or update) the world view for a location inside `container`.
   * Reuses the live canvas when the location is unchanged so the avatar and
   * any in-flight walk survive store re-renders.
   */
  mount(container, locId, pcId) {
    this.pcId = pcId;
    const loc = this.store.entities.get(locId);
    const tiles = loc && loc.tiles;
    if (!tiles || !Array.isArray(tiles.rows)) return false;

    if (this.locId === locId && this.wrap && this.wrap.isConnected) {
      this._dirty();
      return true; // same place, canvas already live
    }

    const cameFrom = this.locId;
    this.locId = locId;
    this.tiles = tiles;
    this.grid = tiles.rows.map(r => [...r].map(ch => (tiles.legend || {})[ch] || 'void'));
    this.exits = tiles.exits || [];
    this.spawns = tiles.spawns || {};
    this.path = [];
    this.pending = null;
    this._travelSent = false;

    // Spawn the avatar: at the exit we just came FROM (arriving through the
    // door we walked into), else at my spawn point, else center.
    const backExit = this.exits.find(e => e.targetId === cameFrom);
    const mySpawn = this.spawns[pcId];
    const start = backExit ? this._insideOf(backExit) : (mySpawn || { x: tiles.w >> 1, y: tiles.h >> 1 });
    this.avatar = { x: start.x, y: start.y };

    // Build DOM
    if (this.wrap) this.wrap.remove();
    this.wrap = document.createElement('div');
    this.wrap.className = 'relative';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'block w-full rounded cursor-crosshair';
    this.canvas.addEventListener('click', (ev) => this._onClick(ev));
    this.canvas.addEventListener('mousemove', (ev) => this._onHover(ev));
    this.wrap.appendChild(this.canvas);

    // Map button (world graph overlay)
    const mapBtn = document.createElement('button');
    mapBtn.textContent = '🗺 world';
    mapBtn.title = 'World map (visited locations)';
    mapBtn.className = 'absolute top-2 right-2 text-[11px] px-2 py-1 rounded bg-black/60 border border-gray-600 text-gray-300 hover:bg-black/80';
    mapBtn.addEventListener('click', () => this._toggleWorldMap());
    this.wrap.appendChild(mapBtn);

    // Location caption
    const cap = document.createElement('div');
    cap.className = 'absolute bottom-2 left-2 text-[11px] px-2 py-0.5 rounded bg-black/60 text-amber-200/90 pointer-events-none';
    cap.textContent = (loc.identity || {}).name || locId;
    this.wrap.appendChild(cap);

    container.appendChild(this.wrap);
    this._rememberVisit(locId);
    this._size();
    this._dirty();
    return true;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this.wrap) this.wrap.remove();
    this.wrap = null;
    this.locId = null;
  }

  // ---- geometry ----

  _size() {
    const w = this.wrap.clientWidth || this.wrap.parentElement?.clientWidth || 640;
    this.tilePx = Math.max(12, Math.floor(w / this.tiles.w));
    this.canvas.width = this.tilePx * this.tiles.w;
    this.canvas.height = this.tilePx * this.tiles.h;
  }

  _tileAt(ev) {
    const r = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / r.width;
    const scaleY = this.canvas.height / r.height;
    return {
      x: Math.floor(((ev.clientX - r.left) * scaleX) / this.tilePx),
      y: Math.floor(((ev.clientY - r.top) * scaleY) / this.tilePx),
    };
  }

  _walkable(x, y) {
    return y >= 0 && y < this.tiles.h && x >= 0 && x < this.tiles.w && WALKABLE.has(this.grid[y][x]);
  }

  /** The walkable tile just inside an edge exit. */
  _insideOf(e) {
    const x = e.x === 0 ? 1 : e.x === this.tiles.w - 1 ? this.tiles.w - 2 : e.x;
    const y = e.y === 0 ? 1 : e.y === this.tiles.h - 1 ? this.tiles.h - 2 : e.y;
    return { x, y };
  }

  /** BFS path (4-dir) from avatar to (tx,ty); returns [{x,y},…] or null. */
  _pathTo(tx, ty) {
    if (!this._walkable(tx, ty)) return null;
    const sx = Math.round(this.avatar.x), sy = Math.round(this.avatar.y);
    const key = (x, y) => y * this.tiles.w + x;
    const prev = new Map([[key(sx, sy), null]]);
    const queue = [[sx, sy]];
    while (queue.length) {
      const [x, y] = queue.shift();
      if (x === tx && y === ty) {
        const path = [];
        let k = key(tx, ty);
        let cur = [tx, ty];
        while (prev.get(k) !== null) {
          path.unshift({ x: cur[0], y: cur[1] });
          cur = prev.get(k);
          k = key(cur[0], cur[1]);
        }
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (this._walkable(nx, ny) && !prev.has(key(nx, ny))) {
          prev.set(key(nx, ny), [x, y]);
          queue.push([nx, ny]);
        }
      }
    }
    return null;
  }

  /** Nearest walkable neighbor of a (possibly blocked) tile, by path length. */
  _adjacentReachable(tx, ty) {
    let best = null, bestLen = Infinity;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = this._pathTo(tx + dx, ty + dy);
      if (p && p.length < bestLen) { best = p; bestLen = p.length; }
    }
    return best;
  }

  // ---- tokens (entities standing here) ----

  _tokens() {
    const out = [];
    for (const [id, comps] of this.store.entities) {
      if (id === this.pcId) continue;
      if (!comps.place || comps.place.locationId !== this.locId) continue;
      const kind = (comps.identity || {}).kind;
      if (kind !== 'npc' && kind !== 'pc' && kind !== 'item') continue;
      if ((comps.status || {}).alive === false) continue;
      const pos = this.spawns[id] || this._fallbackPos(id);
      out.push({
        id,
        x: pos.x, y: pos.y,
        kind,
        name: (comps.identity || {}).name || id,
        hostile: !!(comps.flags || {}).hostile,
        accent: (comps.agent || {}).accent || null,
      });
    }
    return out;
  }

  _fallbackPos(id) {
    // Deterministic ring placement for entities without a spawn point.
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const cx = this.tiles.w >> 1, cy = this.tiles.h >> 1;
    const a = (Math.abs(h) % 360) * Math.PI / 180;
    for (let r = 2; r < 12; r++) {
      const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r * 0.6);
      if (this._walkable(x, y)) return { x, y };
    }
    return { x: cx, y: cy };
  }

  // ---- interaction ----

  _onClick(ev) {
    const { x, y } = this._tileAt(ev);
    const token = this._tokens().find(t => t.x === x && t.y === y);
    const exit = this.exits.find(e => e.x === x && e.y === y);

    if (token && token.kind === 'npc' && token.hostile) {
      const p = this._adjacentReachable(token.x, token.y) || [];
      this._go(p, { type: 'attack', name: token.name });
      return;
    }
    if (token && token.kind === 'npc') {
      const p = this._adjacentReachable(token.x, token.y) || [];
      this._go(p, { type: 'talk', name: token.name });
      return;
    }
    if (token && token.kind === 'item') {
      const p = this._adjacentReachable(token.x, token.y) || this._pathTo(token.x, token.y) || [];
      this._go(p, { type: 'take', name: token.name });
      return;
    }
    if (exit) {
      const p = this._pathTo(exit.x, exit.y) || this._pathTo(this._insideOf(exit).x, this._insideOf(exit).y);
      if (p) this._go(p, { type: 'exit', exit });
      return;
    }
    const p = this._pathTo(x, y);
    if (p) this._go(p, null);
  }

  _onHover(ev) {
    const { x, y } = this._tileAt(ev);
    const token = this._tokens().find(t => t.x === x && t.y === y);
    const exit = this.exits.find(e => e.x === x && e.y === y);
    this.canvas.style.cursor = token || exit ? 'pointer' : 'crosshair';
    this.canvas.title = token ? token.name
      : exit ? `Travel: ${this._exitLabel(exit)}` : '';
  }

  _exitLabel(exit) {
    const target = this.store.entities.get(exit.targetId);
    return (target && target.identity && target.identity.name) || exit.targetId;
  }

  _go(path, pending) {
    if (!path) return;
    this.path = path;
    this.pending = pending;
    this._travelSent = false;
    if (!this._raf) this._animate();
  }

  /** Fire the queued interaction once the walk completes. */
  _arrive() {
    const act = this.pending;
    this.pending = null;
    if (!act) return;
    if (act.type === 'exit' && !this._travelSent) {
      this._travelSent = true;
      // The connection LABEL is what the deterministic exit-resolver matches.
      const loc = this.store.entities.get(this.locId);
      const conn = ((loc.place || {}).connections || []).find(c => c.targetId === act.exit.targetId);
      this.onAction(`go ${conn ? conn.label : this._exitLabel(act.exit)}`);
    } else if (act.type === 'attack') {
      this.onAction(`attack ${act.name}`);
    } else if (act.type === 'take') {
      this.onAction(`pick up the ${act.name}`);
    } else if (act.type === 'talk') {
      const input = document.getElementById('action-input');
      if (input) {
        input.value = `@${act.name.split(' ')[0]} `;
        input.focus();
      }
    }
  }

  // ---- animation + drawing ----

  _animate() {
    this._lastTs = 0;
    const step = (ts) => {
      this._raf = null;
      if (!this.wrap || !this.wrap.isConnected) return;
      if (!this._lastTs) this._lastTs = ts;
      const dt = ts - this._lastTs;

      if (this.path.length) {
        const next = this.path[0];
        const dx = next.x - this.avatar.x, dy = next.y - this.avatar.y;
        const dist = Math.hypot(dx, dy);
        const stepLen = dt / STEP_MS;
        if (dist <= stepLen) {
          this.avatar.x = next.x; this.avatar.y = next.y;
          this.path.shift();
          if (typeof this.onStep === 'function') {
            this.onStep(this.locId, next.x, next.y, this.grid[next.y][next.x]);
          }
          if (!this.path.length) this._arrive();
        } else {
          this.avatar.x += (dx / dist) * stepLen;
          this.avatar.y += (dy / dist) * stepLen;
        }
        this._lastTs = ts;
        this._draw();
        this._raf = requestAnimationFrame(step);
      } else {
        this._draw();
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  _dirty() {
    if (!this._raf && this.wrap && this.wrap.isConnected) {
      this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); if (this.path.length) this._animate(); });
    }
  }

  _draw() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const s = this.tilePx;
    ctx.imageSmoothingEnabled = false;

    // Tiles through the skin
    for (let y = 0; y < this.tiles.h; y++) {
      for (let x = 0; x < this.tiles.w; x++) {
        this.tileset.draw(ctx, this.grid[y][x], x * s, y * s, s, x, y);
      }
    }

    // Exit markers: a soft gold glow
    for (const e of this.exits) {
      ctx.fillStyle = 'rgba(255, 200, 80, 0.28)';
      ctx.fillRect(e.x * s, e.y * s, s, s);
      ctx.strokeStyle = 'rgba(255, 200, 80, 0.8)';
      ctx.strokeRect(e.x * s + 1.5, e.y * s + 1.5, s - 3, s - 3);
    }

    // Path preview dots
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const p of this.path) {
      ctx.beginPath();
      ctx.arc(p.x * s + s / 2, p.y * s + s / 2, Math.max(1.5, s * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }

    // Tokens
    for (const t of this._tokens()) {
      const px = t.x * s + s / 2, py = t.y * s + s / 2;
      if (t.kind === 'item') {
        ctx.fillStyle = '#d9b64a';
        ctx.beginPath();
        ctx.moveTo(px, py - s * 0.22); ctx.lineTo(px + s * 0.22, py);
        ctx.lineTo(px, py + s * 0.22); ctx.lineTo(px - s * 0.22, py);
        ctx.closePath(); ctx.fill();
        continue;
      }
      const r = s * 0.36;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = t.hostile ? '#7c2d2d' : (t.accent || '#3d5a80');
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = t.hostile ? '#ef4444' : 'rgba(255,255,255,0.55)';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(9, s * 0.42)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((t.name[0] || '?').toUpperCase(), px, py + 0.5);
      // Name label
      ctx.font = `${Math.max(8, s * 0.3)}px sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      const label = t.name.length > 18 ? t.name.slice(0, 17) + '…' : t.name;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(px - tw / 2 - 2, py + r + 1, tw + 4, s * 0.36);
      ctx.fillStyle = t.hostile ? '#fca5a5' : '#e5e7eb';
      ctx.fillText(label, px, py + r + 1 + s * 0.18);
    }

    // My avatar (gold)
    if (this.avatar) {
      const px = this.avatar.x * s + s / 2, py = this.avatar.y * s + s / 2;
      ctx.beginPath();
      ctx.arc(px, py, s * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = '#b45309';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fbbf24';
      ctx.stroke();
      const me = this.store.entities.get(this.pcId);
      const myName = ((me || {}).identity || {}).name || 'You';
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(9, s * 0.42)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(myName[0].toUpperCase(), px, py + 0.5);
    }
  }

  // ---- the world map (visited-locations graph overlay) ----

  _visitKey() { return 'ttrpg_visited'; }

  _rememberVisit(locId) {
    try {
      const seen = new Set(JSON.parse(localStorage.getItem(this._visitKey()) || '[]'));
      seen.add(locId);
      localStorage.setItem(this._visitKey(), JSON.stringify([...seen]));
    } catch { /* private mode etc. */ }
  }

  _visited() {
    try { return new Set(JSON.parse(localStorage.getItem(this._visitKey()) || '[]')); }
    catch { return new Set([this.locId]); }
  }

  _toggleWorldMap() {
    if (this._mapEl) { this._mapEl.remove(); this._mapEl = null; return; }
    const visited = this._visited();

    // BFS layering from the current location over the location graph.
    const layers = new Map([[this.locId, 0]]);
    const queue = [this.locId];
    while (queue.length) {
      const id = queue.shift();
      const loc = this.store.entities.get(id);
      for (const c of ((loc || {}).place || {}).connections || []) {
        if (!layers.has(c.targetId)) {
          layers.set(c.targetId, layers.get(id) + 1);
          queue.push(c.targetId);
        }
      }
    }
    const byLayer = new Map();
    for (const [id, l] of layers) {
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(id);
    }

    const el = document.createElement('div');
    el.className = 'absolute inset-0 bg-black/85 rounded z-10 overflow-auto p-4';
    const W = Math.max(this.canvas.clientWidth, 480);
    const layerCount = byLayer.size;
    const c = document.createElement('canvas');
    c.width = W; c.height = Math.max(this.canvas.clientHeight, 90 * layerCount + 40);
    el.appendChild(c);
    const close = document.createElement('button');
    close.textContent = '✕';
    close.className = 'absolute top-2 right-2 text-gray-300 px-2 py-0.5 rounded bg-black/60 border border-gray-600';
    close.addEventListener('click', () => { el.remove(); this._mapEl = null; });
    el.appendChild(close);

    // Layout: layer = row; position nodes evenly within a row.
    const pos = new Map();
    for (const [l, ids] of byLayer) {
      ids.sort();
      ids.forEach((id, i) => {
        pos.set(id, { x: (W / (ids.length + 1)) * (i + 1), y: 50 + l * 90 });
      });
    }

    const ctx = c.getContext('2d');
    // Edges (only where at least one end is visited — the rest stays dark)
    ctx.strokeStyle = 'rgba(150,150,170,0.35)';
    for (const [id] of layers) {
      const loc = this.store.entities.get(id);
      for (const conn of ((loc || {}).place || {}).connections || []) {
        const a = pos.get(id), b = pos.get(conn.targetId);
        if (!a || !b) continue;
        if (!visited.has(id) && !visited.has(conn.targetId)) continue;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // Nodes
    const adjacent = new Set((((this.store.entities.get(this.locId) || {}).place || {}).connections || []).map(c2 => c2.targetId));
    const nodes = [];
    for (const [id, p] of pos) {
      const seen = visited.has(id);
      const isHere = id === this.locId;
      if (!seen && !adjacent.has(id)) {
        // unknown far country: a dim question mark
        ctx.fillStyle = 'rgba(120,120,140,0.25)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, isHere ? 11 : 8, 0, Math.PI * 2);
      ctx.fillStyle = isHere ? '#b45309' : seen ? '#3d5a80' : 'rgba(90,110,140,0.5)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isHere ? '#fbbf24' : 'rgba(255,255,255,0.4)';
      ctx.stroke();
      const name = seen || adjacent.has(id)
        ? (((this.store.entities.get(id) || {}).identity || {}).name || id)
        : '?';
      ctx.fillStyle = seen ? '#e5e7eb' : '#9ca3af';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(name.length > 24 ? name.slice(0, 23) + '…' : name, p.x, p.y + 22);
      nodes.push({ id, ...p, clickable: adjacent.has(id) });
    }

    // Click an ADJACENT location on the map → travel there.
    c.addEventListener('click', (ev) => {
      const r = c.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const hit = nodes.find(n => n.clickable && Math.hypot(n.x - mx, n.y - my) < 14);
      if (hit) {
        el.remove(); this._mapEl = null;
        const loc = this.store.entities.get(this.locId);
        const conn = ((loc.place || {}).connections || []).find(cn => cn.targetId === hit.id);
        if (conn) this.onAction(`go ${conn.label}`);
      }
    });

    this.wrap.appendChild(el);
    this._mapEl = el;
  }
}
