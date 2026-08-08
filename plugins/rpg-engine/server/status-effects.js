/**
 * server/status-effects.js — status effect module (P-ATOM10, pure; wiring next wave).
 *
 * PURE — no imports, no I/O, no module-level (global) mutable state beyond the
 * exported `DEFAULT_REGISTRY` constant (immutable data, not a mutable global).
 * All effect state lives on `entity.effects` (created lazily by `apply`); the
 * tracker returned by `createStatusEffects` holds only its config (registry,
 * maxStacks) in closure, so distinct trackers never interfere with each other
 * or with the entities they act on.
 *
 * Registry entries are fully data-driven: nothing in the logic below refers to
 * 'poison'/'burn'/'stun'/'blessed' by name — behavior is entirely determined
 * by each entry's `duration`, `perTick`, `skipTurn`, `modifiers`, and `stacks`
 * keys. Add a new effect by adding a registry entry; no logic changes needed.
 */

/**
 * @typedef {{duration:number, perTick?:Record<string,number>, skipTurn?:boolean, modifiers?:Record<string,number>, stacks:boolean}} EffectDef
 * @typedef {{id:string, duration:number, stacks:number, source:(string|null)}} EffectEntry
 */

/** Default registry of known status effects (see module doc re: data-driven design). */
export const DEFAULT_REGISTRY = {
  poison: { duration: 3, perTick: { hp: -2 }, stacks: true },
  burn: { duration: 2, perTick: { hp: -3 }, stacks: true },
  stun: { duration: 1, skipTurn: true, stacks: false },
  blessed: { duration: 3, modifiers: { attack: 1 }, stacks: false },
};

/**
 * Create an independent status-effect tracker.
 *
 * @param {object} [opts]
 * @param {Record<string, EffectDef>} [opts.registry=DEFAULT_REGISTRY] — effect id → definition
 * @param {number} [opts.maxStacks=3] — max stacks a `stacks:true` effect may reach on one entity
 * @returns {{
 *   apply: (entity:object, effectId:string, extra?:{source?:string}) => {applied:boolean, stacks:number},
 *   tick: (entity:object) => {expired:string[], deltas:Record<string,number>, skipTurn:boolean},
 *   has: (entity:object, effectId:string) => boolean,
 *   modifiers: (entity:object) => Record<string,number>,
 *   clear: (entity:object, effectId?:string) => void,
 * }}
 */
export function createStatusEffects(opts = {}) {
  const registry = opts.registry != null ? opts.registry : DEFAULT_REGISTRY;
  const maxStacks = opts.maxStacks != null ? opts.maxStacks : 3;

  /** `entity.effects`, initialized to [] on first touch. Never throws. */
  function effectsOf(entity) {
    if (!entity.effects || !Array.isArray(entity.effects)) entity.effects = [];
    return entity.effects;
  }

  /** Active effect entry for `effectId` on `entity`, or null. Never throws. */
  function findEntry(entity, effectId) {
    const list = (entity && Array.isArray(entity.effects)) ? entity.effects : [];
    return list.find((e) => e.id === effectId) || null;
  }

  /**
   * Apply `effectId` (looked up in the registry) to `entity`. Unknown effect
   * ids are a no-op. Stacking effects (`stacks:true`) add a stack — up to
   * `maxStacks` — and refresh duration on each successful stack; beyond the
   * cap the call is refused. Non-stacking effects always stay at 1 stack and
   * simply refresh duration on reapply.
   * @param {object} entity
   * @param {string} effectId
   * @param {{source?:string}} [extra]
   * @returns {{applied:boolean, stacks:number}}
   */
  function apply(entity, effectId, extra) {
    const list = effectsOf(entity);
    const def = registry[effectId];
    if (!def) return { applied: false, stacks: 0 };

    const source = (extra && extra.source != null) ? extra.source : null;
    let entry = list.find((e) => e.id === effectId);

    if (!entry) {
      entry = { id: effectId, duration: def.duration, stacks: 1, source };
      list.push(entry);
      return { applied: true, stacks: entry.stacks };
    }

    if (def.stacks) {
      if (entry.stacks >= maxStacks) return { applied: false, stacks: entry.stacks };
      entry.stacks += 1;
      entry.duration = def.duration;
      entry.source = source;
      return { applied: true, stacks: entry.stacks };
    }

    // Non-stacking reapply: stays at 1 stack, just refreshes duration.
    entry.duration = def.duration;
    entry.source = source;
    return { applied: true, stacks: entry.stacks };
  }

  /**
   * Advance all of `entity`'s active effects by one tick: sums each active
   * effect's `perTick` deltas (scaled by its stack count) into a single
   * per-stat total, decrements durations, and removes (expires) any effect
   * whose duration reaches 0. Never throws on an entity without `.effects`.
   * @param {object} entity
   * @returns {{expired:string[], deltas:Record<string,number>, skipTurn:boolean}}
   */
  function tick(entity) {
    const list = (entity && Array.isArray(entity.effects)) ? entity.effects : [];
    const deltas = {};
    let skipTurn = false;

    for (const entry of list) {
      const def = registry[entry.id];
      if (!def) continue;
      if (def.perTick) {
        for (const [stat, amount] of Object.entries(def.perTick)) {
          deltas[stat] = (deltas[stat] || 0) + amount * entry.stacks;
        }
      }
      if (def.skipTurn) skipTurn = true;
    }

    const expired = [];
    for (const entry of list) {
      entry.duration -= 1;
      if (entry.duration <= 0) expired.push(entry.id);
    }

    if (expired.length) {
      entity.effects = list.filter((e) => !expired.includes(e.id));
    }

    return { expired, deltas, skipTurn };
  }

  /** True if `entity` currently has `effectId` active. Never throws. */
  function has(entity, effectId) {
    return findEntry(entity, effectId) !== null;
  }

  /**
   * Merged modifiers from all of `entity`'s active effects, summed per key
   * and scaled by each effect's stack count. Never throws.
   * @param {object} entity
   * @returns {Record<string,number>}
   */
  function modifiers(entity) {
    const list = (entity && Array.isArray(entity.effects)) ? entity.effects : [];
    const merged = {};
    for (const entry of list) {
      const def = registry[entry.id];
      if (!def || !def.modifiers) continue;
      for (const [key, amount] of Object.entries(def.modifiers)) {
        merged[key] = (merged[key] || 0) + amount * entry.stacks;
      }
    }
    return merged;
  }

  /**
   * Remove one effect (`effectId`) or every active effect from `entity`.
   * Never throws on an entity without `.effects`.
   * @param {object} entity
   * @param {string} [effectId] — omit to clear every active effect
   */
  function clear(entity, effectId) {
    if (!entity || !Array.isArray(entity.effects)) return;
    if (effectId == null) {
      entity.effects = [];
      return;
    }
    entity.effects = entity.effects.filter((e) => e.id !== effectId);
  }

  return { apply, tick, has, modifiers, clear };
}
