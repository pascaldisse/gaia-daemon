/**
 * shared/worldcheck.js — PURE referential-integrity validator for world entity-maps.
 *
 * Checks the concrete structure the running engine depends on:
 *   - PC present + unique, at least one location
 *   - PC placed at a real location
 *   - every location connection references a real location
 *   - connections are bidirectional
 *   - non-location placements resolve to a location
 *   - quest triggers reference real entities (right kind per trigger type)
 *
 * inventory.items[].id and quest rewards.items[].id are NOT checked.
 * Never throws — guard against missing components; report as errors.
 */

/**
 * @param {Record<string, object>} entities  — { id: components }
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWorld(entities) {
  const errors = [];

  // ---- helpers -----------------------------------------------------------

  /** Get the identity.kind of an entity (or null if missing). */
  function kind(id) {
    const e = entities[id];
    if (!e || !e.identity) return null;
    return e.identity.kind;
  }

  /** Build [id, comps] array for safe iteration. */
  const entries = Object.keys(entities).map(id => ({ id, comps: entities[id] || {} }));

  // ---- 1. PC present (exactly one) --------------------------------------

  const pcEntities = entries.filter(e => e.comps.identity && e.comps.identity.kind === 'pc');
  if (pcEntities.length === 0) {
    errors.push('No PC entity found');
  } else if (pcEntities.length > 1) {
    errors.push(`Multiple PC entities found: ${pcEntities.map(e => e.id).join(', ')}`);
  }

  // ---- 2. At least one location -----------------------------------------

  const locIds = entries.filter(e => e.comps.identity && e.comps.identity.kind === 'location').map(e => e.id);
  if (locIds.length === 0) {
    errors.push('No location entities found');
  }

  // ---- 3. PC location resolves ------------------------------------------

  if (pcEntities.length === 1) {
    const pc = pcEntities[0];
    const pcPlace = pc.comps.place;
    if (!pcPlace || pcPlace.locationId == null) {
      errors.push(`PC '${pc.id}' has no place.locationId`);
    } else if (kind(pcPlace.locationId) !== 'location') {
      errors.push(`PC '${pc.id}' location '${pcPlace.locationId}' does not exist or is not a location`);
    }
  }

  // ---- 4. Location connection targets exist + are locations -------------

  for (const locId of locIds) {
    const loc = entities[locId];
    const connections = loc.place && loc.place.connections;
    if (!Array.isArray(connections)) continue;
    for (const conn of connections) {
      const targetId = conn && conn.targetId;
      if (!targetId) continue;
      if (kind(targetId) !== 'location') {
        errors.push(
          `Location '${locId}' connection target '${targetId}' does not exist or is not a location`
        );
      }
    }
  }

  // ---- 5. Connections bidirectional -------------------------------------

  for (const locId of locIds) {
    const loc = entities[locId];
    const connections = loc.place && loc.place.connections;
    if (!Array.isArray(connections)) continue;
    for (const conn of connections) {
      const targetId = conn && conn.targetId;
      if (!targetId) continue;
      // Only check when the target IS a real location (otherwise already caught by #4)
      if (kind(targetId) !== 'location') continue;
      const target = entities[targetId];
      const targetConns = target.place && target.place.connections;
      if (!Array.isArray(targetConns) || !targetConns.some(c => c && c.targetId === locId)) {
        errors.push(
          `Location '${locId}' connects to '${targetId}' but '${targetId}' does not connect back`
        );
      }
    }
  }

  // ---- 6. Non-location placement resolves to a location -----------------

  for (const e of entries) {
    if (!e.comps.identity) continue;
    if (e.comps.identity.kind === 'location') continue;
    const place = e.comps.place;
    if (!place || place.locationId == null) continue;
    if (kind(place.locationId) !== 'location') {
      errors.push(
        `Entity '${e.id}' placement at '${place.locationId}' does not resolve to a location`
      );
    }
  }

  // ---- 7. Quest triggers reference real entities ------------------------

  for (const e of entries) {
    const questComp = e.comps.quest;
    if (!questComp) continue;
    const triggers = questComp.triggers;
    if (!Array.isArray(triggers)) continue;
    for (const trigger of triggers) {
      if (!trigger || !trigger.type) continue;

      if (trigger.type === 'atLocation') {
        if (kind(trigger.id) !== 'location') {
          errors.push(
            `Quest '${e.id}' atLocation trigger target '${trigger.id}' does not exist or is not a location`
          );
        }
      } else if (trigger.type === 'dead') {
        if (!entities[trigger.id]) {
          errors.push(
            `Quest '${e.id}' dead trigger target '${trigger.id}' does not exist`
          );
        }
      } else if (trigger.type === 'allDead') {
        if (Array.isArray(trigger.ids)) {
          for (const tid of trigger.ids) {
            if (!entities[tid]) {
              errors.push(
                `Quest '${e.id}' allDead trigger target '${tid}' does not exist`
              );
            }
          }
        }
      } else if (trigger.type === 'hasItem') {
        if (kind(trigger.id) !== 'item') {
          errors.push(
            `Quest '${e.id}' hasItem trigger target '${trigger.id}' does not exist or is not an item`
          );
        }
      }
      // unknown trigger types are silently ignored
    }
  }

  // ---- result -----------------------------------------------------------

  return { ok: errors.length === 0, errors };
}
