/**
 * server/sense.js — the sense API.
 * Text senses over the canonical entity store. PURE-ish: reads session.entities.
 *
 * Based on GAIA's sense.js text-sense pattern.
 */

import { buildLookFrame } from '../shared/context.js';
import { pcLocationId } from '../shared/space.js';
import { clockLine } from '../shared/clock.js';

/**
 * Build a compact text scene frame — the "living summary".
 *
 * Delegates to the canonical, LOCATION-SCOPED builder in shared/context.js so
 * there is exactly ONE scene-frame generator. Shows only what is present at the
 * PC's current location (+ party, active quests, world flags).
 *
 * @param {import('./session.js').Session} session
 * @returns {string}
 */
export function look(session, pcId) {
  const { entities } = session;
  if (!entities || entities.size === 0) {
    return 'Current scene: (empty — no entities loaded).';
  }
  // P4: the DM always knows what time it is — narration follows the clock.
  const frame = buildLookFrame(entities, pcId);
  const ws = entities.get('world-state');
  return ws && ws.clock ? `Time: ${clockLine(ws)}.\n${frame}` : frame;
}

/**
 * One-line entity summary.
 * @param {import('./session.js').Session} session
 * @param {string} id
 * @returns {string}
 */
export function describe(session, id) {
  const comps = session.entities.get(id);
  if (!comps) return `Entity "${id}" not found.`;

  const identity = comps.identity || {};
  const name = identity.name || id;
  const kind = identity.kind || '?';
  const desc = identity.description || '';
  const status = comps.status || {};
  const alive = status.alive !== false ? '' : ' [DEAD]';
  const place = comps.place || {};
  const at = place.locationId ? ` at ${place.locationId}` : '';

  return `${name} (${id}) — ${kind}${alive}${at}${desc ? ': ' + desc : ''}`;
}

/**
 * Query entities by component and/or kind.
 * @param {import('./session.js').Session} session
 * @param {{has?:string, kind?:string, at?:string}} params
 * @returns {Array<{id:string, components:object}>}
 */
export function query(session, { has, kind, at } = {}) {
  const results = [];
  for (const [id, comps] of session.entities) {
    const identity = comps.identity || {};

    // Filter by kind
    if (kind && identity.kind !== kind) continue;

    // Filter by component presence
    if (has && !comps[has]) continue;

    // Filter by location
    if (at) {
      const place = comps.place || {};
      if (place.locationId !== at && id !== at) continue;
    }

    results.push({ id, components: JSON.parse(JSON.stringify(comps)) });
  }
  return results;
}

/**
 * Consistency lint — basic checks.
 * Returns a list of finding strings.
 *
 * @param {import('./session.js').Session} session
 * @returns {string[]}
 */
export function check(session) {
  const { entities } = session;
  const findings = [];
  const ids = new Set(entities.keys());

  // Detect duplicate ids (already impossible with Map, but check just in case — checking
  // against journal might reveal them; skip for P2)

  for (const [id, comps] of entities) {
    const identity = comps.identity || {};
    const kind = identity.kind || '?';
    const place = comps.place || {};

    // Check place.locationId references
    if (place.locationId && !ids.has(place.locationId)) {
      findings.push(`${id} (${identity.name || '?'}) references missing location "${place.locationId}"`);
    }

    // Check NPC marked dead still present (false positive if corpse — warn)
    const status = comps.status || {};
    if (kind === 'npc' && status.alive === false) {
      findings.push(`${id} (${identity.name || '?'}) is an NPC marked dead but still present in entities`);
    }

    // Check connections
    if (comps.place && comps.place.connections) {
      for (const conn of comps.place.connections) {
        if (conn.targetId && !ids.has(conn.targetId)) {
          findings.push(`${id} connection "${conn.label || conn.targetId}" references missing target "${conn.targetId}"`);
        }
      }
    }
  }

  return findings;
}

/**
 * Return the agent-NPCs present at the PC's CURRENT location
 * (identity.kind==='npc' && agent.enabled && co-located with the PC).
 * Used by the routing engine — an NPC in another room never answers.
 *
 * If the PC has no location, falls back to all agent-NPCs (degenerate single-room).
 *
 * @param {import('./session.js').Session} session
 * @param {string} [pcId] — scope to this PC's location (default: first PC)
 * @returns {Array<{npcId:string, name:string, persona:string, accent:string|null, locationId:string|null}>}
 */
export function presentAgents(session, pcId) {
  const here = pcLocationId(session.entities, pcId);
  const agents = [];
  for (const [id, comps] of session.entities) {
    const identity = comps.identity || {};
    if (identity.kind !== 'npc') continue;

    const agent = comps.agent || {};
    if (!agent.enabled) continue;

    const status = comps.status || {};
    if (status.alive === false) continue;

    const place = comps.place || {};

    // Location scoping: only NPCs co-located with the PC. If we can't determine
    // the PC's location, include all agent-NPCs (single-room fallback).
    if (here && place.locationId !== here) continue;

    const persona = comps.persona || {};
    agents.push({
      npcId: id,
      name: identity.name || id,
      persona: persona.personality || '',
      accent: agent.accent || null,
      locationId: place.locationId || null,
    });
  }
  return agents;
}
