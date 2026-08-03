/**
 * shared/quest-triggers.js — quest trigger evaluation + pending advance computation.
 *
 * PURE — no imports from server/ or client/. Operates on an entities Map
 * (or plain object) of { id → { componentName: value } }.
 *
 * A quest is a state machine driven by declarative triggers evaluated against
 * world state. After every player turn the server re-evaluates active quests:
 * if the current step's trigger is satisfied, the quest advances (or completes).
 * This module computes which advances are *pending* — it never mutates state.
 *
 * EXTENSION SEAM: rulesets/campaigns add trigger types by wrapping/subclassing
 * `triggerMet`. The core vocabulary below covers exploration, items, story flags,
 * and combat kills — enough to tie phases P4-P5 together.
 */

import { findPcs, pcLocationId, locationOf } from './space.js';

// ---- Helpers ----------------------------------------------------------------

/** Iterate entity [id, comps] pairs from a Map or plain object. */
function entries(entities) {
  return entities instanceof Map ? [...entities.entries()] : Object.entries(entities);
}

/** Look up one entity's components from a Map or plain object. */
function getEntity(entities, id) {
  return entities instanceof Map ? entities.get(id) : entities[id];
}

/**
 * Deep-equality check for trigger values (handles primitives, arrays, objects).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => deepEqual(a[k], b[k]));
}

// ---- Trigger evaluation -----------------------------------------------------

/**
 * Evaluate whether a single trigger descriptor is satisfied by the current
 * world state (entities Map/object). Returns `false` for unknown trigger types.
 *
 * Supported trigger shapes:
 *   { type:'flag', key, value, id? }
 *     — `flags[key]` on entity `id` (default 'world-state') deep-equals `value`.
 *   { type:'atLocation', id }
 *     — party-wide form: ANY living PC's current location id equals `id`.
 *   { type:'atLocation', id, location }
 *     — entity-specific form (has a `location` field): entity `id`'s current
 *       location id equals `location`. `id` may be any entity, not just a PC.
 *   { type:'inZone', id, zone }
 *     — entity `id`'s current location carries zone data (its `flags.zone` or
 *       `flags.zoneId`) equal to `zone`. No location, or a location with no zone
 *       data, → false (never throws).
 *   { type:'hasItem', id }
 *     — the PC's inventory contains an item whose id === `id`.
 *   { type:'dead', id }
 *     — entity `id` is absent OR its `status.alive === false`.
 *   { type:'allDead', ids:[] }
 *     — every id in `ids` is dead (per the `dead` rule).
 *   { type:'anyOf', triggers:[...] }
 *     — met when ANY nested trigger is met.
 *
 * @param {object} trigger — a trigger descriptor
 * @param {Map|object} entities — the full entity store
 * @returns {boolean}
 */
export function triggerMet(trigger, entities) {
  if (!trigger || typeof trigger !== 'object') return false;
  if (!entities) return false;

  switch (trigger.type) {
    case 'flag': {
      const targetId = trigger.id || 'world-state';
      const entity = getEntity(entities, targetId);
      if (!entity || !entity.flags) return false;
      return deepEqual(entity.flags[trigger.key], trigger.value);
    }

    case 'atLocation': {
      // Entity-specific form: a `location` field targets one entity's location
      // directly (that entity need not be a PC).
      if (trigger.location !== undefined) {
        return locationOf(entities, trigger.id) === trigger.location;
      }
      // Legacy party-wide form: ANY living PC standing at location `id`.
      return findPcs(entities).some(([_id, c]) =>
        (c.status || {}).alive !== false &&
        ((c.place || {}).locationId || null) === trigger.id);
    }

    case 'inZone': {
      const locId = locationOf(entities, trigger.id);
      if (!locId) return false;
      const location = getEntity(entities, locId);
      if (!location) return false;
      const flags = location.flags || {};
      const zone = flags.zone !== undefined ? flags.zone : flags.zoneId;
      if (zone === undefined) return false;
      return zone === trigger.zone;
    }

    case 'hasItem': {
      // Party-aware: ANY PC carrying it satisfies the trigger.
      return findPcs(entities).some(([_id, c]) =>
        ((c.inventory && c.inventory.items) || []).some(item => item.id === trigger.id));
    }

    case 'dead': {
      const entity = getEntity(entities, trigger.id);
      // absent entity is considered dead
      if (!entity) return true;
      return (entity.status && entity.status.alive) === false;
    }

    case 'allDead': {
      if (!Array.isArray(trigger.ids) || trigger.ids.length === 0) return false;
      return trigger.ids.every(id => {
        const entity = getEntity(entities, id);
        if (!entity) return true;
        return (entity.status && entity.status.alive) === false;
      });
    }

    case 'anyOf':
      return (trigger.triggers || []).some(t => triggerMet(t, entities));

    default:
      return false;
  }
}

// ---- Pending advances -------------------------------------------------------

/**
 * Compute all quest advances that are currently pending (trigger met) without
 * mutating any state. Returns intent objects that the server will apply as ops
 * and loop until stable.
 *
 * For each active quest at step `currentStep`:
 *   - read `quest.triggers[currentStep]`
 *   - if defined and `triggerMet` is true:
 *       fromStep = currentStep
 *       toStep = currentStep + 1
 *       completes = (toStep >= steps.length)
 *
 * @param {Map|object} entities — the full entity store
 * @returns {Array<{questId:string, fromStep:number, toStep:number,
 *                   completes:boolean, rewards?:{xp:number,items:Array}>}>}
 */
export function pendingAdvances(entities) {
  const advances = [];

  for (const [id, comps] of entries(entities)) {
    const quest = comps.quest;
    if (!quest) continue;
    if (quest.phase !== 'active') continue;

    const steps = quest.steps || [];
    const triggers = quest.triggers || [];
    const currentStep = typeof quest.currentStep === 'number' ? quest.currentStep : 0;

    // No trigger at this step → no advance pending
    const trigger = triggers[currentStep];
    if (!trigger) continue;

    if (!triggerMet(trigger, entities)) continue;

    const fromStep = currentStep;
    const toStep = currentStep + 1;
    const completes = toStep >= steps.length;

    advances.push({
      questId: id,
      fromStep,
      toStep,
      completes,
      rewards: completes ? (quest.rewards || { xp: 0, items: [] }) : undefined,
    });
  }

  return advances;
}
