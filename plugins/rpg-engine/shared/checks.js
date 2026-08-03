/**
 * shared/checks.js — pluggable check engine + 5e defaults.
 *
 * PURE — no imports from server/ or client/.
 *
 * EXTENSION SEAM: rulesets ship check definitions as DATA (ruleset/checks.js).
 * 5e (d20 roll-high vs DC) and DSA5 (3d20 roll-under + QS) use the SAME engine,
 * different data. Add new check kinds by adding entries to CHECK_DEFS.
 *
 * The engine always rolls dice — the caller/LLM NEVER supplies dice values.
 */

import { makeRng } from './rng.js';

// ---- 5e helpers ----

/** D&D 5e ability modifier: floor((score - 10) / 2). */
export function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

// ---- Check definitions registry (EXTENSION SEAM) ----

/**
 * Check definitions indexed by check kind.
 * Each definition describes how to resolve a check:
 *   - dice: {count, sides} — what to roll
 *   - comparator: 'ge' (roll-high-vs-DC, 5e) | 'le' (roll-under, DSA)
 *   - modSource(ctx): number — how to compute the modifier from actor context
 *   - resolve(rolls, mod, dc, def, ctx): {success, margin, crit, fumble, summary...}
 *     — for custom resolution logic
 */
export const CHECK_DEFS = {
  'ability-check': {
    doc: 'D&D 5e ability check (d20 + ability mod + proficiency vs DC).',
    dice: { count: 1, sides: 20 },
    comparator: 'ge',
    /** @param {{ability?:string, skill?:string, stats?:object, proficiency?:number}} ctx */
    modSource(ctx) {
      const abi = ctx.ability || 'wis';
      const score = (ctx.stats && ctx.stats[abi]) || 10;
      let mod = abilityMod(score);
      // Proficiency: add if skill is listed (simple heuristic; full skill list in P6)
      if (ctx.skill && ctx.proficiency) {
        mod += ctx.proficiency;
      }
      return mod;
    },
    resolve(rolls, mod, dc, _def, _ctx) {
      const d20 = rolls[0];
      const total = d20 + mod;
      const success = total >= dc;
      const margin = total - dc;
      const crit = d20 === 20;
      const fumble = d20 === 1;
      const outcome = crit ? 'CRITICAL SUCCESS'
        : fumble ? 'FUMBLE'
        : success ? 'SUCCESS'
        : 'FAILURE';
      return {
        rolls,
        modifier: mod,
        total,
        dc,
        success,
        margin,
        crit,
        fumble,
        summary: `d20(${d20}) + ${mod} = ${total} vs DC ${dc} → ${outcome}`,
        outcome,
      };
    },
  },

  'attack': {
    doc: 'D&D 5e attack roll (d20 + attack modifier vs AC).',
    dice: { count: 1, sides: 20 },
    comparator: 'ge',
    modSource(ctx) {
      // Use str or dex based on ctx; default str
      const abi = ctx.ability || 'str';
      const score = (ctx.stats && ctx.stats[abi]) || 10;
      let mod = abilityMod(score);
      if (ctx.proficiency) mod += ctx.proficiency;
      return mod;
    },
    resolve(rolls, mod, dc, _def, _ctx) {
      const d20 = rolls[0];
      const total = d20 + mod;
      const success = total >= dc;
      const margin = total - dc;
      const crit = d20 === 20;
      const fumble = d20 === 1;
      const outcome = crit ? 'CRITICAL HIT'
        : fumble ? 'CRITICAL MISS'
        : success ? 'HIT'
        : 'MISS';
      return {
        rolls,
        modifier: mod,
        total,
        dc,
        success,
        margin,
        crit,
        fumble,
        summary: `d20(${d20}) + ${mod} = ${total} vs AC ${dc} → ${outcome}`,
        outcome,
      };
    },
  },

  'saving-throw': {
    doc: 'D&D 5e saving throw (d20 + ability mod + proficiency vs DC).',
    dice: { count: 1, sides: 20 },
    comparator: 'ge',
    modSource(ctx) {
      const abi = ctx.ability || 'con';
      const score = (ctx.stats && ctx.stats[abi]) || 10;
      let mod = abilityMod(score);
      if (ctx.proficiency) mod += ctx.proficiency;
      return mod;
    },
    resolve(rolls, mod, dc, _def, _ctx) {
      const d20 = rolls[0];
      const total = d20 + mod;
      const success = total >= dc;
      const margin = total - dc;
      const crit = d20 === 20;
      const fumble = d20 === 1;
      const outcome = success ? 'SAVED' : 'FAILED';
      return {
        rolls,
        modifier: mod,
        total,
        dc,
        success,
        margin,
        crit,
        fumble,
        summary: `d20(${d20}) + ${mod} = ${total} vs DC ${dc} → ${outcome}`,
        outcome,
      };
    },
  },
};

// ---- Check registration (EXTENSION SEAM) ----

/**
 * Register check definitions from a ruleset or campaign.
 * Deep-merges into CHECK_DEFS. Pure, idempotent.
 * Mirrors registerComponents in shared/schema.js.
 *
 * @param {Record<string,object>} defs — { kind: {dice,comparator,modSource,resolve} }
 */
export function registerChecks(defs) {
  for (const [kind, def] of Object.entries(defs)) {
    if (CHECK_DEFS[kind]) {
      // Merge fields into existing definition
      Object.assign(CHECK_DEFS[kind], def);
    } else {
      CHECK_DEFS[kind] = { ...def };
    }
  }
}

// ---- Resolver ----

/**
 * Resolve ONE check against a ruleset definition.
 *
 * The engine rolls dice — the caller/LLM NEVER supplies dice values.
 *
 * @param {object} checkDef — a check descriptor: {check, ability?, skill?, dc, reason?}
 * @param {object} ctx — actor context: {stats, proficiency, ...}
 * @param {{d:(sides:number)=>number, int:(min:number,max:number)=>number}} rng
 * @returns {{rolls:number[], modifier:number, total:number, dc:number, success:boolean,
 *            margin:number, crit:boolean, fumble:boolean, summary:string, outcome:string, def:string}}
 */
export function resolveCheck(checkDef, ctx, rng) {
  const kind = checkDef.check || 'ability-check';
  const def = CHECK_DEFS[kind];

  if (!def) {
    // Unknown check kind — fall back to ability-check
    const fallback = CHECK_DEFS['ability-check'];
    const rolls = [rng.d(fallback.dice.sides)];
    const mod = fallback.modSource({ ...ctx, ...checkDef });
    const dc = checkDef.dc ?? 10;
    return fallback.resolve(rolls, mod, dc, fallback, { ...ctx, ...checkDef });
  }

  // Roll dice
  const rolls = [];
  for (let i = 0; i < def.dice.count; i++) {
    rolls.push(rng.d(def.dice.sides));
  }

  // Compute modifier from actor context
  const mod = def.modSource({ ...ctx, ...checkDef });
  // ?? not ||: dc 0 is a legal difficulty in roll-under systems (DSA Erschwernis ±0).
  const dc = checkDef.dc ?? 10;

  return def.resolve(rolls, mod, dc, def, { ...ctx, ...checkDef });
}


/**
 * Build a formatted display string for a check result.
 * @param {object} result — from resolveCheck
 * @returns {string}
 */
export function formatCheckResult(result) {
  const icon = result.crit ? '🎉' : result.fumble ? '💀' : result.success ? '✅' : '❌';
  const kind = result.def || 'check';
  return `${icon} ${kind}: ${result.summary}`;
}
