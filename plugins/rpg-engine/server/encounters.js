/**
 * server/encounters.js — random encounter roller (pure engine, no session wiring).
 *
 * A tick-driven gate: every world tick, `maybeRoll` checks a cooldown then rolls
 * against a chance to trigger a weighted pick from a content table. Deterministic
 * under an injected `rng()` (a 0..1 generator, same signature as Math.random) so
 * tests can stub exact outcomes. Wiring into the live session/turn loop is a
 * later wave — this module only produces encounter objects or null.
 */

/**
 * @typedef {object} EncounterEntry
 * @property {string} id
 * @property {number} weight — relative pick weight (larger = more likely)
 * @property {string} prompt — DM seed text
 * @property {Array<object>} [hostiles] — optional hostile stat blocks
 */

/**
 * Create a random encounter engine.
 * @param {object} [opts]
 * @param {EncounterEntry[]} [opts.table=[]] — weighted encounter table
 * @param {number} [opts.chance=0.15] — per-roll trigger probability (0..1)
 * @param {number} [opts.cooldownTicks=6] — minimum ticks between triggers
 * @param {() => number} [opts.rng=Math.random] — injected 0..1 rng for determinism
 * @returns {{maybeRoll: (args: {tick: number}) => (EncounterEntry|null), reset: () => void}}
 */
export function createEncounterEngine(opts = {}) {
  const {
    table = [],
    chance = 0.15,
    cooldownTicks = 6,
    rng = Math.random,
  } = opts;

  let lastTick = -Infinity;

  /** Weighted pick over `table` using one rng() draw. Null if table is empty/all-zero-weight. */
  function pickWeighted() {
    const totalWeight = table.reduce((sum, e) => sum + (e.weight || 0), 0);
    if (totalWeight <= 0) return null;
    let roll = rng() * totalWeight;
    for (const entry of table) {
      roll -= (entry.weight || 0);
      if (roll < 0) return entry;
    }
    return table[table.length - 1];
  }

  /**
   * Roll for a random encounter this tick.
   * @param {{tick: number}} args — current world tick
   * @returns {EncounterEntry|null} the picked encounter, or null if cooldown/chance blocked it
   */
  function maybeRoll({ tick }) {
    if (tick - lastTick < cooldownTicks) return null;
    if (rng() >= chance) return null;
    const encounter = pickWeighted();
    if (!encounter) return null;
    lastTick = tick;
    return encounter;
  }

  /** Clear the cooldown so the very next maybeRoll() is unblocked by it. */
  function reset() {
    lastTick = -Infinity;
  }

  return { maybeRoll, reset };
}
