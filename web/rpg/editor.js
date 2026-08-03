/**
 * client/editor.js — Level Editor v0.
 *
 * Read-only WebSocket watcher (mirrors client/kernel/frontdoor.js's
 * _watchEpilogue pattern: snapshot/spawn/set/merge/despawn into a local
 * entity map, never sends `hello`) + POST /op for all mutations, exactly
 * like every other canon-mutating surface in this client. No server changes.
 */

const PORT = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
const HTTP = `${location.protocol}//${location.hostname}:${PORT}`;
const WS_URL = `ws://${location.hostname}:${PORT}`;

/** @type {Map<string, object>} id -> components */
let entities = new Map();
let selectedId = null;
/** Deep-cloned snapshot of the selected entity's components at selection/apply time, for diffing. */
let baseline = null;

const els = {
  conn: document.getElementById('ed-conn'),
  list: document.getElementById('ed-entity-list'),
  selectedLabel: document.getElementById('ed-selected-id'),
  json: document.getElementById('ed-json'),
  apply: document.getElementById('ed-apply'),
  status: document.getElementById('ed-status'),
  despawn: document.getElementById('ed-despawn'),
  spawnBtn: document.getElementById('ed-spawn'),
  graphEmpty: document.getElementById('ed-graph-empty'),
  graph: document.getElementById('ed-graph'),
  exitList: document.getElementById('ed-exit-list'),
  exitTarget: document.getElementById('ed-exit-target'),
  exitLabel: document.getElementById('ed-exit-label'),
  exitDistance: document.getElementById('ed-exit-distance'),
  exitAdd: document.getElementById('ed-exit-add'),
  spawnOverlay: document.getElementById('ed-spawn-overlay'),
  spawnKind: document.getElementById('ed-spawn-kind'),
  spawnJson: document.getElementById('ed-spawn-json'),
  spawnStatus: document.getElementById('ed-spawn-status'),
  spawnClose: document.getElementById('ed-spawn-close'),
  spawnCancel: document.getElementById('ed-spawn-cancel'),
  spawnConfirm: document.getElementById('ed-spawn-confirm'),
};

// ---- WebSocket: read-only mirror (never sends hello) ----

function applyIncomingOp(op) {
  switch (op.op) {
    case 'spawn':
      if (op.id) entities.set(op.id, { ...(op.components || {}) });
      break;
    case 'set':
      if (op.id && entities.has(op.id) && op.component) {
        const comps = entities.get(op.id);
        if (op.value === null || op.value === undefined) delete comps[op.component];
        else comps[op.component] = (op.value && typeof op.value === 'object') ? { ...op.value } : op.value;
      }
      break;
    case 'merge':
      if (op.id) {
        if (!entities.has(op.id)) entities.set(op.id, {});
        const comps = entities.get(op.id);
        if (op.component && op.value) comps[op.component] = { ...(comps[op.component] || {}), ...op.value };
      }
      break;
    case 'despawn':
      if (op.id) entities.delete(op.id);
      break;
  }
}

let socket = null;
function connect() {
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    setConn(false);
    setTimeout(connect, 2000);
    return;
  }
  socket.onopen = () => setConn(true);
  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    if (msg.type === 'snapshot') {
      entities = new Map(Object.entries(msg.entities || {}));
      renderList();
      if (selectedId && !entities.has(selectedId)) deselect();
      else if (selectedId) refreshSelectedFromLive();
    } else if (msg.type === 'ops') {
      for (const op of msg.ops || []) applyIncomingOp(op);
      renderList();
      if (selectedId && !entities.has(selectedId)) deselect();
      else if (selectedId) refreshSelectedFromLive();
    }
    // No `hello` is ever sent — this socket is read-only and never binds a seat.
  };
  socket.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  socket.onerror = () => {};
}

function setConn(ok) {
  els.conn.textContent = ok ? 'connected' : 'reconnecting…';
  els.conn.className = ok ? 'text-sm text-emerald-500' : 'text-sm text-gray-500';
}

// ---- Entity list ----

const KIND_ORDER = ['location', 'npc', 'pc', 'item', 'quest', 'faction', 'world-state', 'presence', 'other'];
const KIND_LABEL = {
  location: 'Locations', npc: 'NPCs', pc: 'PCs', item: 'Items', quest: 'Quests',
  faction: 'Factions', 'world-state': 'World state', presence: 'Presence', other: 'Other',
};

function kindOf(comps) {
  const k = comps && comps.identity && comps.identity.kind;
  return KIND_ORDER.includes(k) ? k : 'other';
}

function renderList() {
  const groups = new Map(KIND_ORDER.map(k => [k, []]));
  const ids = Array.from(entities.keys()).sort();
  for (const id of ids) {
    const comps = entities.get(id);
    groups.get(kindOf(comps)).push(id);
  }
  els.list.replaceChildren();
  for (const kind of KIND_ORDER) {
    const ids2 = groups.get(kind);
    if (!ids2.length) continue;
    const header = document.createElement('div');
    header.className = 'text-xs uppercase tracking-wider text-gray-600 mt-1 first:mt-0 ed-group-label';
    header.textContent = `${KIND_LABEL[kind]} (${ids2.length})`;
    els.list.appendChild(header);
    for (const id of ids2) {
      const comps = entities.get(id);
      const name = (comps.identity && comps.identity.name) || id;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ed-entity-row text-left px-2 py-1.5 rounded border border-gray-800 bg-gray-950 hover:bg-gray-800 transition-colors' + (id === selectedId ? ' selected' : '');
      row.innerHTML = `<div class="text-gray-100 truncate">${escapeHtml(name)}</div><div class="text-xs text-gray-500 truncate">${escapeHtml(id)}</div>`;
      row.addEventListener('click', () => selectEntity(id));
      els.list.appendChild(row);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Selection + JSON editor ----

function selectEntity(id) {
  selectedId = id;
  baseline = JSON.parse(JSON.stringify(entities.get(id) || {}));
  els.selectedLabel.textContent = id;
  els.json.value = JSON.stringify(baseline, null, 2);
  els.json.disabled = false;
  els.apply.disabled = false;
  els.despawn.disabled = false;
  els.status.textContent = '';
  renderList();
  renderGraph();
}

function deselect() {
  selectedId = null;
  baseline = null;
  els.selectedLabel.textContent = 'none';
  els.json.value = '';
  els.json.disabled = true;
  els.apply.disabled = true;
  els.despawn.disabled = true;
  els.status.textContent = '';
  renderList();
  renderGraph();
}

/** Live entity changed under us (broadcast from elsewhere) — refresh baseline/textarea if untouched. */
function refreshSelectedFromLive() {
  const live = entities.get(selectedId);
  if (!live) return;
  // Only auto-refresh if the textarea still matches the last-known baseline
  // (i.e. the user hasn't started editing) — avoid clobbering in-progress edits.
  let current;
  try { current = JSON.parse(els.json.value); } catch (_) { return; }
  if (JSON.stringify(current) === JSON.stringify(baseline)) {
    baseline = JSON.parse(JSON.stringify(live));
    els.json.value = JSON.stringify(baseline, null, 2);
  }
  renderGraph();
}

els.apply.addEventListener('click', async () => {
  if (!selectedId) return;
  let edited;
  try {
    edited = JSON.parse(els.json.value);
  } catch (e) {
    els.status.textContent = `Invalid JSON: ${e.message}`;
    els.status.className = 'text-xs text-red-400 mt-1 shrink-0 min-h-[1em]';
    return;
  }
  const ops = [];
  const before = baseline || {};
  const keys = new Set([...Object.keys(before), ...Object.keys(edited)]);
  for (const key of keys) {
    const a = before[key];
    const b = Object.prototype.hasOwnProperty.call(edited, key) ? edited[key] : undefined;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    // Full-replace semantics — the textarea holds the whole component value,
    // so `set` (not `merge`) is correct here (merge would only add/overwrite
    // keys, never remove fields the user deleted).
    ops.push({ op: 'set', id: selectedId, component: key, value: b === undefined ? null : b });
  }
  if (!ops.length) {
    els.status.textContent = 'No changes.';
    els.status.className = 'text-xs text-gray-500 mt-1 shrink-0 min-h-[1em]';
    return;
  }
  const res = await postOps(ops);
  if (res.ok) {
    baseline = JSON.parse(JSON.stringify(edited));
    els.status.textContent = `Applied ${ops.length} component change(s).`;
    els.status.className = 'text-xs text-emerald-400 mt-1 shrink-0 min-h-[1em]';
  } else {
    els.status.textContent = `Error: ${res.error}`;
    els.status.className = 'text-xs text-red-400 mt-1 shrink-0 min-h-[1em]';
  }
});

els.despawn.addEventListener('click', async () => {
  if (!selectedId) return;
  if (!confirm(`Despawn entity "${selectedId}"? This cannot be undone.`)) return;
  const res = await postOps([{ op: 'despawn', id: selectedId }]);
  if (res.ok) {
    deselect();
  } else {
    els.status.textContent = `Error: ${res.error}`;
    els.status.className = 'text-xs text-red-400 mt-1 shrink-0 min-h-[1em]';
  }
});

// ---- Location graph (place.connections) ----

function renderGraph() {
  const comps = selectedId ? entities.get(selectedId) : null;
  const isLocation = comps && kindOf(comps) === 'location';
  if (!isLocation) {
    els.graphEmpty.classList.remove('hidden');
    els.graph.classList.add('hidden');
    return;
  }
  els.graphEmpty.classList.add('hidden');
  els.graph.classList.remove('hidden');
  const connections = (comps.place && Array.isArray(comps.place.connections)) ? comps.place.connections : [];
  els.exitList.replaceChildren();
  if (!connections.length) {
    const empty = document.createElement('div');
    empty.className = 'text-gray-600 italic text-sm';
    empty.textContent = 'No exits.';
    els.exitList.appendChild(empty);
  }
  connections.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-2 border border-gray-800 rounded px-2 py-1';
    const label = document.createElement('div');
    label.className = 'truncate';
    label.innerHTML = `<span class="text-gray-100">${escapeHtml(c.targetId ?? '?')}</span>` +
      (c.label ? ` <span class="text-gray-500">— ${escapeHtml(c.label)}</span>` : '') +
      (c.distance != null ? ` <span class="text-gray-600 text-xs">(${escapeHtml(String(c.distance))})</span>` : '');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'text-xs text-red-400 hover:text-red-300 shrink-0';
    removeBtn.textContent = 'remove';
    removeBtn.addEventListener('click', () => removeExit(i));
    row.append(label, removeBtn);
    els.exitList.appendChild(row);
  });
}

async function removeExit(index) {
  const comps = entities.get(selectedId);
  const connections = (comps.place && Array.isArray(comps.place.connections)) ? comps.place.connections : [];
  const next = connections.filter((_, i) => i !== index);
  const res = await postOps([{ op: 'merge', id: selectedId, component: 'place', value: { connections: next } }]);
  if (!res.ok) {
    els.status.textContent = `Error: ${res.error}`;
    els.status.className = 'text-xs text-red-400 mt-1 shrink-0 min-h-[1em]';
  }
  // Live broadcast will update `entities` + re-render via the WS handler.
}

els.exitAdd.addEventListener('click', async () => {
  if (!selectedId) return;
  const targetId = els.exitTarget.value.trim();
  if (!targetId) {
    els.status.textContent = 'Exit needs a targetId.';
    els.status.className = 'text-xs text-red-400 mt-1 shrink-0 min-h-[1em]';
    return;
  }
  const entry = { targetId };
  const label = els.exitLabel.value.trim();
  if (label) entry.label = label;
  const distRaw = els.exitDistance.value.trim();
  if (distRaw !== '') {
    const n = Number(distRaw);
    entry.distance = Number.isFinite(n) ? n : distRaw;
  }
  const comps = entities.get(selectedId);
  const connections = (comps.place && Array.isArray(comps.place.connections)) ? comps.place.connections : [];
  const next = [...connections, entry];
  const res = await postOps([{ op: 'merge', id: selectedId, component: 'place', value: { connections: next } }]);
  if (res.ok) {
    els.exitTarget.value = '';
    els.exitLabel.value = '';
    els.exitDistance.value = '';
  } else {
    els.status.textContent = `Error: ${res.error}`;
    els.status.className = 'text-xs text-red-400 mt-1 shrink-0 min-h-[1em]';
  }
});

// ---- Spawn overlay ----

const SPAWN_TEMPLATES = {
  location: {
    id: 'new-location',
    components: {
      identity: { name: 'New Location', kind: 'location', description: '' },
      place: { locationId: null, connections: [] },
    },
  },
  npc: {
    id: 'new-npc',
    components: {
      identity: { name: 'New NPC', kind: 'npc', description: '' },
      place: { locationId: null },
    },
  },
  item: {
    id: 'new-item',
    components: {
      identity: { name: 'New Item', kind: 'item', description: '' },
    },
  },
  quest: {
    id: 'new-quest',
    components: {
      identity: { name: 'New Quest', kind: 'quest', description: '' },
    },
  },
  faction: {
    id: 'new-faction',
    components: {
      identity: { name: 'New Faction', kind: 'faction', description: '' },
    },
  },
  pc: {
    id: 'new-pc',
    components: {
      identity: { name: 'New PC', kind: 'pc', description: '' },
      place: { locationId: null },
    },
  },
};

function openSpawnOverlay() {
  els.spawnKind.value = 'location';
  els.spawnJson.value = JSON.stringify(SPAWN_TEMPLATES.location, null, 2);
  els.spawnStatus.textContent = '';
  els.spawnOverlay.style.display = 'flex';
}
function closeSpawnOverlay() {
  els.spawnOverlay.style.display = 'none';
}

els.spawnBtn.addEventListener('click', openSpawnOverlay);
els.spawnClose.addEventListener('click', closeSpawnOverlay);
els.spawnCancel.addEventListener('click', closeSpawnOverlay);
els.spawnKind.addEventListener('change', () => {
  els.spawnJson.value = JSON.stringify(SPAWN_TEMPLATES[els.spawnKind.value] || {}, null, 2);
});
els.spawnConfirm.addEventListener('click', async () => {
  let payload;
  try {
    payload = JSON.parse(els.spawnJson.value);
  } catch (e) {
    els.spawnStatus.textContent = `Invalid JSON: ${e.message}`;
    els.spawnStatus.className = 'text-xs text-red-400 min-h-[1em]';
    return;
  }
  if (!payload || typeof payload !== 'object' || !payload.components) {
    els.spawnStatus.textContent = 'Template must include a "components" object.';
    els.spawnStatus.className = 'text-xs text-red-400 min-h-[1em]';
    return;
  }
  const op = { op: 'spawn', components: payload.components };
  if (payload.id) op.id = payload.id;
  const res = await postOps([op]);
  if (res.ok) {
    closeSpawnOverlay();
    if (res.applied && res.applied[0] && res.applied[0].id) selectEntity(res.applied[0].id);
  } else {
    els.spawnStatus.textContent = `Error: ${res.error}`;
    els.spawnStatus.className = 'text-xs text-red-400 min-h-[1em]';
  }
});

// ---- POST /op ----

async function postOps(ops) {
  try {
    const res = await fetch(`${HTTP}/op`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, from: 'editor' }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, applied: body.applied };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Boot ----

deselect();
connect();
