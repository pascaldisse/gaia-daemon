/**
 * shared/progression.js — XP, level, and proficiency computations (5e).
 *
 * PURE — no imports from server/ or client/. Takes plain data, returns plain data.
 * Never mutates inputs.
 *
 * EXTENSION SEAM: rulesets can replace XP_THRESHOLDS or wrap applyXp to add
 * class features, spell slots, feat choices, etc.
 */

/**
 * 5e cumulative XP thresholds at the START of each level, index = level - 1.
 * Levels 1–10; clamp above level 10.
 */
export const XP_THRESHOLDS = [
  0,      // L1
  300,    // L2
  900,    // L3
  2700,   // L4
  6500,   // L5
  14000,  // L6
  23000,  // L7
  34000,  // L8
  48000,  // L9
  64000,  // L10
];

/**
 * Return the character level (1-based) for a given total XP.
 * If XP exceeds the highest threshold, returns the maximum level (10).
 * @param {number} xp — total experience points
 * @returns {number} level (1–10)
 */
export function levelForXp(xp) {
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

/**
 * 5e proficiency bonus: 2 + floor((level - 1) / 4).
 * Level 1–4 → +2, 5–8 → +3, 9–12 → +4, etc.
 * @param {number} level
 * @returns {number}
 */
export function proficiencyForLevel(level) {
  return 2 + Math.floor((level - 1) / 4);
}

/**
 * Unspent stat points granted per level gained via `applyXp`'s progression
 * tracking. Mirrors server/progression.js's `createProgression` default
 * (`statPointsPerLevel = 2`) so combat/quest XP and the direct spend-point
 * endpoint award points at the same rate. Override via `applyXp`'s
 * `opts.pointsPerLevel` — never hardcode a different value inline.
 */
export const POINTS_PER_LEVEL = 2;

/**
 * Apply XP to a stats object, returning a NEW stats object with updated
 * xp, level, proficiency, maxHp, and hp (full heal on level-up).
 *
 * Never mutates the input `stats` (or the optional `progression` input).
 *
 * On level-up:
 *   - Sets `level` to the new level.
 *   - Sets `proficiency` via `proficiencyForLevel`.
 *   - Raises `maxHp` by `(5 + conMod)` per level gained (conMod = floor((con-10)/2)).
 *   - Sets `hp = maxHp` (full heal).
 *
 * If `stats.xp` is undefined/missing, treats it as 0.
 *
 * ALSO derives an updated progression component — `{ xp, level, unspentPoints }`
 * matching the shape maintained by server/progression.js's `createProgression`
 * (entity.progression) — using the exact same level curve as `stats.level`
 * (`levelForXp`/`XP_THRESHOLDS`, no second curve). This lets callers keep
 * `entity.progression.unspentPoints` in sync with combat/quest XP awards
 * (via `applyXp`) instead of only via the separate `/progression/spend`
 * addXp path. Pass the entity's current `progression` (or omit/undefined to
 * start fresh at `{ xp: 0, level: 1, unspentPoints: 0 }`); the returned
 * `progression` is a NEW object — callers merge/assign it themselves.
 *
 * @param {object} stats — { hp, maxHp, level, proficiency, con, xp?, ... }
 * @param {number} amount — XP to add (must be >= 0)
 * @param {object} [progression] — current { xp, level, unspentPoints }, or omitted for fresh
 * @param {object} [opts]
 * @param {number} [opts.pointsPerLevel=POINTS_PER_LEVEL] — unspent points granted per level gained
 * @returns {{ stats: object, gained: number, leveledUp: boolean,
 *             fromLevel: number, toLevel: number, progression: object }}
 */
export function applyXp(stats, amount, progression, opts = {}) {
  const { pointsPerLevel = POINTS_PER_LEVEL } = opts;

  const oldXp = (stats.xp != null) ? stats.xp : 0;
  const newXp = oldXp + amount;

  const oldLevel = stats.level || 1;
  const newLevel = levelForXp(newXp);
  const leveledUp = newLevel > oldLevel;
  const levelsGained = newLevel - oldLevel;

  const newStats = { ...stats, xp: newXp, level: newLevel };

  if (leveledUp) {
    const conScore = newStats.con || 10;
    const conMod = Math.floor((conScore - 10) / 2);
    const hpGainPerLevel = 5 + conMod;
    const oldMaxHp = newStats.maxHp || 10;

    newStats.proficiency = proficiencyForLevel(newLevel);
    newStats.maxHp = oldMaxHp + hpGainPerLevel * levelsGained;
    newStats.hp = newStats.maxHp;
  }

  const oldProgression = progression || { xp: 0, level: 1, unspentPoints: 0 };
  const newProgression = {
    xp: newXp,
    level: newLevel,
    unspentPoints: (oldProgression.unspentPoints || 0) + (leveledUp ? levelsGained * pointsPerLevel : 0),
  };

  return {
    stats: newStats,
    gained: amount,
    leveledUp,
    fromLevel: oldLevel,
    toLevel: newLevel,
    progression: newProgression,
  };
}
