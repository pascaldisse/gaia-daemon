/**
 * shared/rng.js — deterministic seeded PRNG.
 *
 * PURE — no imports. Uses mulberry32 for stable, reproducible dice rolls.
 * Deterministic + reproducible so tests and replays are stable.
 * Do NOT use Math.random in shared/ — all randomness goes through this.
 */

/**
 * Create a seeded PRNG from a numeric seed.
 * Returns an object with next(), int(min,max), and d(sides).
 *
 * @param {number} seed — integer seed
 * @returns {{next: ()=>number, int: (min:number, max:number)=>number, d: (sides:number)=>number}}
 */
export function makeRng(seed) {
  // mulberry32 — fast, good distribution, 32-bit state
  let state = seed | 0;

  function next() {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Roll an integer in [min, max] inclusive. */
  function int(min, max) {
    return min + Math.floor(next() * (max - min + 1));
  }

  /** Roll a die with `sides` faces (e.g. d20, d6). */
  function d(sides) {
    return int(1, sides);
  }

  return { next, int, d };
}
