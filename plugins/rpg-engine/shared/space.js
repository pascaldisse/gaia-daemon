/**
 * shared/space.js — the location graph.
 *
 * PURE — no imports from server/ or client/. Operates on an entities Map
 * (or plain object) of { id → { componentName: value } }.
 *
 * This is the single source of truth for "where is the PC", "what is physically
 * present at a location", and "where can you go from here". Both the scene-frame
 * builder (shared/context.js) and the routing/turn engine (server/) consume it,
 * so "only what's HERE is present" is decided in exactly one place.
 *
 * Convention:
 *   - A location entity has identity.kind === 'location'. It IS a place; its own
 *     place.locationId is null/absent. Its place.connections are the exits.
 *   - Everything else (pc/npc/item) is AT a location via place.locationId.
 *   - A CARRIED item has place.locationId === <holder id> (a pc/npc), so it is
 *     naturally excluded from any location query — it left the ground when taken.
 */

/** Iterate entity [id, comps] pairs from a Map or plain object. */
function entries(entities) {
  return entities instanceof Map ? [...entities.entries()] : Object.entries(entities);
}

/** Look up one entity's components from a Map or plain object. */
function get(entities, id) {
  return entities instanceof Map ? entities.get(id) : entities[id];
}

/**
 * Find the first player character entity (single-player fallback / party leader).
 * @returns {[string, object]|null} [id, comps] or null
 */
export function findPc(entities) {
  for (const [id, comps] of entries(entities)) {
    if ((comps.identity || {}).kind === 'pc') return [id, comps];
  }
  return null;
}

/**
 * All player character entities (the party).
 * @returns {Array<[string, object]>}
 */
export function findPcs(entities) {
  const out = [];
  for (const [id, comps] of entries(entities)) {
    if ((comps.identity || {}).kind === 'pc') out.push([id, comps]);
  }
  return out;
}

/**
 * The PC a player drives, resolved from the action's `by` name.
 * A PC is bound to its player via agent.controller (set at hello). Resolution:
 * exact controller match → identity.name match → an unbound PC → first PC.
 * @param {Map|object} entities
 * @param {string} [by] — the acting player's name (actionOp.by / presence.who)
 * @returns {[string, object]|null}
 */
export function findPcFor(entities, by) {
  const pcs = findPcs(entities);
  if (!pcs.length) return null;
  if (by) {
    const byLower = String(by).toLowerCase();
    const bound = pcs.find(([_id, c]) => ((c.agent || {}).controller || '').toLowerCase() === byLower);
    if (bound) return bound;
    const named = pcs.find(([_id, c]) => (((c.identity || {}).name) || '').toLowerCase() === byLower);
    if (named) return named;
    const unbound = pcs.find(([_id, c]) => !(c.agent || {}).controller);
    if (unbound) return unbound;
  }
  return pcs[0];
}

/**
 * The location id an entity currently occupies (or null).
 * @returns {string|null}
 */
export function locationOf(entities, id) {
  const comps = get(entities, id);
  if (!comps) return null;
  return (comps.place && comps.place.locationId) || null;
}

/**
 * The location id a PC currently occupies (or null).
 * @param {Map|object} entities
 * @param {string} [pcId] — a specific PC; default: the first PC
 * @returns {string|null}
 */
export function pcLocationId(entities, pcId) {
  if (pcId) return locationOf(entities, pcId);
  const pc = findPc(entities);
  if (!pc) return null;
  return (pc[1].place && pc[1].place.locationId) || null;
}

/**
 * Entities physically present at a location (place.locationId === locId).
 * Excludes the location entity itself. Skips dead NPCs unless includeDead.
 *
 * @param {Map|object} entities
 * @param {string} locId
 * @param {object} [opts]
 * @param {string[]} [opts.kinds]      — restrict to these identity.kinds
 * @param {boolean} [opts.includeDead] — include status.alive===false entities
 * @param {string}  [opts.exclude]     — an entity id to omit (e.g. the PC itself)
 * @returns {Array<[string, object]>}
 */
export function entitiesAt(entities, locId, opts = {}) {
  const { kinds, includeDead = false, exclude } = opts;
  const out = [];
  if (!locId) return out;
  for (const [id, comps] of entries(entities)) {
    if (id === locId || id === exclude) continue;
    const place = comps.place || {};
    if (place.locationId !== locId) continue;
    const kind = (comps.identity || {}).kind;
    if (kinds && !kinds.includes(kind)) continue;
    if (!includeDead && (comps.status || {}).alive === false) continue;
    out.push([id, comps]);
  }
  return out;
}

/**
 * Exits leading out of a location.
 * @returns {Array<{targetId:string, label:string, exists:boolean}>}
 */
export function exitsFrom(entities, locId) {
  const comps = get(entities, locId);
  if (!comps) return [];
  const connections = (comps.place && comps.place.connections) || [];
  return connections.map(c => ({
    targetId: c.targetId || '',
    label: c.label || c.targetId || '',
    exists: !!(c.targetId && get(entities, c.targetId)),
  }));
}

/** True if `toLoc` is directly reachable from `fromLoc`. */
export function isConnected(entities, fromLoc, toLoc) {
  return exitsFrom(entities, fromLoc).some(e => e.targetId === toLoc);
}

// ---- Exit phrase matching (for the deterministic movement fast-path) ----

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'into', 'onto', 'through', 'down', 'up',
  'over', 'and', 'go', 'goes', 'going', 'move', 'walk', 'head', 'travel',
  'enter', 'leave', 'exit', 'toward', 'towards', 'in', 'out', 'at', 'on',
]);

/** Normalize free text → lowercase words, punctuation stripped. */
function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Distinctive content words for one exit (target name, label, id tail). */
function exitTokens(entities, exit) {
  const target = get(entities, exit.targetId) || {};
  const name = (target.identity || {}).name || '';
  const idTail = exit.targetId.replace(/^loc-/, '');
  const raw = `${name} ${exit.label} ${idTail}`;
  const tokens = new Set();
  for (const w of norm(raw).split(' ')) {
    if (w && !STOPWORDS.has(w)) tokens.add(w);
  }
  return tokens;
}

/**
 * Match a free-text movement phrase to a CONNECTED exit's target.
 * Returns the target location id, or null if nothing matched confidently
 * (no match, or an ambiguous tie — callers fall back to LLM adjudication).
 *
 * @param {Map|object} entities
 * @param {string} fromLocId
 * @param {string} phrase — the player's text (movement verb may still be present)
 * @returns {string|null}
 */
export function resolveExit(entities, fromLocId, phrase) {
  const p = ` ${norm(phrase)} `;
  if (p.trim() === '') return null;

  const candidates = [];
  for (const exit of exitsFrom(entities, fromLocId)) {
    if (!exit.exists) continue;
    let score = 0;
    for (const t of exitTokens(entities, exit)) {
      if (p.includes(` ${t} `)) score = Math.max(score, t.length);
    }
    if (score > 0) candidates.push({ targetId: exit.targetId, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  // Ambiguous tie between different targets → let the LLM decide.
  if (
    candidates.length > 1 &&
    candidates[0].score === candidates[1].score &&
    candidates[0].targetId !== candidates[1].targetId
  ) {
    return null;
  }
  return candidates[0].targetId;
}
