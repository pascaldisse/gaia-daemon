/**
 * server/progression.js — XP/level progression module (pure; wiring lands next wave).
 *
 * PURE — mutates only the `entity` passed in (its `progression` sub-object),
 * no session/broadcast/IO. All thresholds and rewards are configurable via
 * `opts`, each with a sane default (IRON RULE: no hardcoded varying values).
 *
 * `entity.progression` shape: { xp: number, level: number, unspentPoints: number }.
 * Initialized lazily by `addXp`/`spendPoint` on first touch so callers never need
 * to pre-seed it.
 */

/** @typedef {'questStep'|'questComplete'|'combatWin'} XpEvent */

/**
 * @param {object} [opts]
 * @param {number} [opts.xpPerQuestStep=25] — XP granted for `xpFor('questStep')`
 * @param {number} [opts.xpPerQuestComplete=100] — XP granted for `xpFor('questComplete')`
 * @param {number} [opts.xpPerCombatWin=50] — XP granted for `xpFor('combatWin')`
 * @param {number} [opts.statPointsPerLevel=2] — unspent stat points granted per level gained
 * @param {(level: number) => number} [opts.levelCurve] — XP needed to go from `level` to `level+1`; defaults to `100 * level`
 */
export function createProgression(opts = {}) {
  const {
    xpPerQuestStep = 25,
    xpPerQuestComplete = 100,
    xpPerCombatWin = 50,
    statPointsPerLevel = 2,
    levelCurve = (level) => 100 * level,
  } = opts;

  const XP_FOR = {
    questStep: xpPerQuestStep,
    questComplete: xpPerQuestComplete,
    combatWin: xpPerCombatWin,
  };

  /** Ensure `entity.progression` exists with its default shape, then return it. */
  function ensureProgression(entity) {
    if (!entity.progression) {
      entity.progression = { xp: 0, level: 1, unspentPoints: 0 };
    }
    return entity.progression;
  }

  /**
   * Add XP to `entity`, applying (possibly multiple) level-ups.
   * @param {object} entity
   * @param {number} amount
   * @returns {{leveled: boolean, levelsGained: number, level: number}}
   */
  function addXp(entity, amount) {
    const progression = ensureProgression(entity);
    const gain = Number.isFinite(amount) ? amount : 0;
    progression.xp += gain;

    let levelsGained = 0;
    while (progression.xp >= levelCurve(progression.level)) {
      progression.xp -= levelCurve(progression.level);
      progression.level += 1;
      progression.unspentPoints += statPointsPerLevel;
      levelsGained += 1;
    }

    return { leveled: levelsGained > 0, levelsGained, level: progression.level };
  }

  /**
   * XP reward configured for a given event.
   * @param {XpEvent|string} event
   * @returns {number} the configured amount, or 0 for an unknown event (never throws)
   */
  function xpFor(event) {
    return XP_FOR[event] || 0;
  }

  /**
   * Spend one unspent stat point on `entity.stats[statName]`.
   * @param {object} entity
   * @param {string} statName
   * @returns {boolean} true if spent, false if refused (no points, or not a numeric stat)
   */
  function spendPoint(entity, statName) {
    const progression = ensureProgression(entity);
    if (progression.unspentPoints <= 0) return false;
    const stats = entity.stats;
    if (!stats || typeof stats[statName] !== 'number') return false;

    stats[statName] += 1;
    progression.unspentPoints -= 1;
    return true;
  }

  return { addXp, xpFor, spendPoint };
}
