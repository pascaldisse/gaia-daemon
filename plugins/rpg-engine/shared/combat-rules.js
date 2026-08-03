/**
 * shared/combat-rules.js — pure combat engine.
 *
 * PURE — no imports from server/ or client/. Takes plain data + an rng; returns plain data.
 * NEVER mutates inputs. NEVER emits ops — the server layer turns results into ops.
 *
 * EXTENSION SEAM (rules-as-data): a loaded ruleset bundle may export a `combat`
 * object to override the default 5e behaviour. Both public entry points take an
 * optional `rules` argument (the bundle's `combat` export):
 *   - `rules.resolveAttack(params, entities, rng)` → fully replaces attack resolution.
 *   - `rules.initiativeMode === 'fixed'` → no initiative roll; turn order is the
 *     declared order (allies then enemies), e.g. Necrotopia's "GM announces order".
 * When `rules` is absent, the 5e defaults below apply:
 *   - `rollInitiative` = d20 + abilityMod(dex)
 *   - `resolveAttack`  = d20 attack roll (via resolveCheck) + weapon die damage
 *   - Finesse detection reads `flags.finesse` on the attacker
 *   - Weapon die reads `flags.damage` (e.g. "1d8") or defaults to "1d6"
 *
 * Dependencies: resolveCheck / abilityMod from ./checks.js, makeRng from ./rng.js.
 */

import { resolveCheck, abilityMod } from './checks.js';
import { aggregateModifiers, speedMultiplier, STATUS_DEFS } from './statuses.js';

// ---- Helpers ----

/**
 * Parse a damage-die string like "1d6", "2d8", "3d4" into { count, sides }.
 * Returns { count: 1, sides: 6 } on unparseable input.
 * @param {string} die
 * @returns {{count:number, sides:number}}
 */
function parseDamageDie(die) {
  const m = /^(\d+)d(\d+)$/.exec(die);
  if (m) return { count: Number(m[1]), sides: Number(m[2]) };
  return { count: 1, sides: 6 };
}

/**
 * Read the attacker's weapon damage die string.
 * Checks flags.damage first, then looks for a weapon item, defaults to "1d6".
 * @param {object} attacker - entity components Map entry for attacker
 * @param {Map<string,object>} entities - full entity store (for weapon lookup)
 * @returns {string}
 */
function readDamageDie(attacker, entities) {
  // flags.damage takes priority
  if (attacker?.flags?.damage) return attacker.flags.damage;
  // Try weapon in inventory (simple: first weapon item with damage field)
  if (attacker?.inventory?.items) {
    for (const itemRef of attacker.inventory.items) {
      const itemId = typeof itemRef === 'string' ? itemRef : itemRef.id;
      const item = entities?.get(itemId);
      if (item?.flags?.damage) return item.flags.damage;
      if (item?.identity?.kind === 'item' && item?.flags?.weapon && item?.flags?.damage) {
        return item.flags.damage;
      }
    }
  }
  return '1d6';
}

/**
 * Determine which ability score to use for an attack.
 * Finesse weapons use dex; otherwise str.
 * @param {object} attacker - attacker entity components
 * @returns {'str'|'dex'}
 */
function attackAbility(attacker) {
  if (attacker?.flags?.finesse === true) return 'dex';
  return 'str';
}

// ---- Public API ----

/**
 * Roll initiative for a list of combatant ids.
 * `init = d20 + abilityMod(dex)`. Sorted by init DESC.
 * Tie-break: higher dex score, then entity id (localeCompare).
 *
 * @param {string[]} ids - combatant entity ids
 * @param {Map<string,object>} entities - entity store (read-only)
 * @param {{d:(s:number)=>number}} rng
 * @returns {{id:string, init:number}[]} sorted by initiative DESC
 */
export function rollInitiative(ids, entities, rng) {
  const results = ids.map(id => {
    const comps = entities.get(id);
    const stats = comps?.stats || {};
    const dex = stats.dex ?? 10;
    const roll = rng.d(20);
    const init = roll + abilityMod(dex);
    return { id, init, dex };
  });

  results.sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init;       // DESC by init
    if (b.dex !== a.dex) return b.dex - a.dex;            // higher dex first
    return a.id.localeCompare(b.id);                       // alphabetical id
  });

  return results.map(({ id, init }) => ({ id, init }));
}

/**
 * Build an encounter component object from allies+enemies lists.
 * Rolls initiative for all combatants and assembles the turn order.
 *
 * @param {{allies:string[], enemies:string[]}} params
 * @param {Map<string,object>} entities
 * @param {{d:(s:number)=>number}} rng
 * @param {object} [rules] — ruleset combat override. `initiativeMode:'fixed'` skips
 *   the roll and uses the declared order (allies then enemies).
 * @returns {object} encounter component value (active, round, order, turnIndex, mode, enemies, allies)
 */
export function buildEncounter({ allies, enemies }, entities, rng, rules = {}) {
  const allIds = [...allies, ...enemies];
  let order;
  let mode;
  if (rules.initiativeMode === 'fixed') {
    // No initiative roll — the GM declares order: the party acts, then the foes.
    order = allIds;
    mode = 'round-robin';
  } else {
    order = rollInitiative(allIds, entities, rng).map(r => r.id);
    mode = 'initiative';
  }
  return {
    active: true,
    round: 1,
    order,
    turnIndex: 0,
    mode,
    enemies: [...enemies],
    allies: [...allies],
  };
}

/**
 * Return the entity id whose turn it currently is.
 * @param {object} encounter - encounter component value
 * @returns {string|null} current combatant id, or null if order is empty
 */
export function currentCombatant(encounter) {
  if (!encounter?.order?.length) return null;
  return encounter.order[encounter.turnIndex] ?? null;
}

/**
 * Resolve a single attack: attacker vs target.
 *
 * Steps:
 * 1. Determine attack ability (str unless attacker has finesse → dex).
 * 2. Parse damage die from flags.damage or weapon item (default 1d6).
 * 3. Call resolveCheck('attack') against target.stats.ac.
 * 4. On hit: roll weapon die + ability mod (min 1). Crit doubles the dice.
 * 5. Return structured result with summary string.
 *
 * @param {{attackerId:string, targetId:string}} params
 * @param {Map<string,object>} entities
 * @param {{d:(s:number)=>number}} rng
 * @param {object} [rules] — ruleset combat override. If `rules.resolveAttack` is a
 *   function it fully replaces the 5e resolution below (same params/return shape).
 * @returns {{hit:boolean, crit:boolean, fumble:boolean, attackRoll:number, ac:number, damage:number, summary:string, ability:string, weaponDie:string}}
 */
export function resolveAttack({ attackerId, targetId }, entities, rng, rules = {}) {
  // C1: status modifiers (rage +dmg, armor-aura +armor, flawless-aim autoHit, …).
  // Computed by the engine and threaded into the resolver — the bundle stays import-free.
  const mods = aggregateModifiers(entities, attackerId, targetId);

  // Rules-as-data seam: a ruleset may supply an entirely different attack model
  // (e.g. Necrotopia's d6 > Armor). Delegate wholesale when present.
  if (typeof rules.resolveAttack === 'function') {
    return rules.resolveAttack({ attackerId, targetId }, entities, rng, mods);
  }

  const attacker = entities.get(attackerId);
  const target = entities.get(targetId);

  if (!attacker || !target) {
    return {
      hit: false, crit: false, fumble: false,
      attackRoll: 0, ac: 0, damage: 0,
      summary: 'Invalid attacker or target.',
      ability: 'str', weaponDie: '1d6',
    };
  }

  const ability = attackAbility(attacker);
  const weaponDieStr = readDamageDie(attacker, entities);
  const weaponDie = parseDamageDie(weaponDieStr);
  const targetAc = (target?.stats?.ac ?? 10) + (mods.armorDelta || 0);

  // Resolve the attack check (hitDelta nudges the effective AC; autoHit forces a hit)
  const checkResult = resolveCheck(
    { check: 'attack', ability, dc: targetAc - (mods.hitDelta || 0) },
    { stats: attacker.stats || {}, proficiency: attacker.proficiency ?? attacker.stats?.proficiency ?? 0 },
    rng,
  );
  const hit = mods.autoHit ? true : checkResult.success;

  let damage = 0;
  if (hit) {
    const abilityScore = (attacker.stats || {})[ability] ?? 10;
    const mod = abilityMod(abilityScore);
    const diceCount = checkResult.crit ? weaponDie.count * 2 : weaponDie.count;
    let diceTotal = 0;
    for (let i = 0; i < diceCount; i++) {
      diceTotal += rng.d(weaponDie.sides);
    }
    damage = Math.max(1, diceTotal + mod + (mods.dmgDelta || 0));
  }

  const summary = checkResult.crit
    ? `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → CRITICAL HIT (${damage} damage)`
    : checkResult.fumble
      ? `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → CRITICAL MISS`
      : checkResult.success
        ? `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → HIT (${damage} damage)`
        : `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → MISS`;

  return {
    hit,
    crit: checkResult.crit,
    fumble: checkResult.fumble,
    attackRoll: checkResult.rolls[0],
    ac: targetAc,
    damage,
    summary,
    ability,
    weaponDie: weaponDieStr,
  };
}

/**
 * Resolve a declared Move (C1). The neutral entry point: the engine computes the
 * status modifiers (rage/armor/aim/…) and delegates to the ruleset's
 * `combat.resolveMove(move, params, entities, rng, mods)`. A ruleset that ships no
 * resolveMove gets a minimal default (heal / basic-attack-for-damage).
 *
 * Return shape: { ops:Op[], statusOps:Op[], summary:string, detail?:object }
 *   - ops       — damage/heal semantic ops (engine expands + applies)
 *   - statusOps — applyStatus semantic ops (engine expands + applies, broadcasts status lines)
 *
 * @param {object} move — a Move from the actor's moves.list
 * @param {{actorId:string, targetId?:string}} params
 * @param {Map<string,object>} entities
 * @param {{d:(s:number)=>number}} rng
 * @param {object} [rules] — ruleset combat override
 */
export function resolveMove(move, params, entities, rng, rules = {}) {
  const mods = aggregateModifiers(entities, params.actorId, params.targetId);

  if (typeof rules.resolveMove === 'function') {
    return rules.resolveMove(move, params, entities, rng, mods);
  }

  // Minimal neutral default (rarely used — every move-using ruleset ships resolveMove).
  const type = move.type || 'damage';
  if (type === 'heal') {
    const die = parseDamageDie(move.damage || '1d6');
    let amt = 0;
    for (let i = 0; i < die.count; i++) amt += rng.d(die.sides);
    const tid = params.targetId || params.actorId;
    return { ops: [{ op: 'heal', id: tid, amount: amt }], statusOps: [], summary: `${move.name}: heals ${amt}` };
  }
  if (type === 'buff' || type === 'stun' || type === 'utility') {
    return { ops: [], statusOps: [], summary: `${move.name}` };
  }
  const r = resolveAttack({ attackerId: params.actorId, targetId: params.targetId }, entities, rng, rules);
  return {
    ops: r.hit && r.damage > 0 ? [{ op: 'damage', id: params.targetId, amount: r.damage }] : [],
    statusOps: [],
    summary: `${move.name}: ${r.summary}`,
    detail: { hit: r.hit, damage: r.damage },
  };
}

/**
 * Advance the encounter's turn to the next living combatant.
 * Skips combatants where `status.alive === false`.
 * When wrapping past the end of the order, increments `round`.
 * Returns a NEW object — never mutates the input.
 *
 * @param {object} encounter - current encounter component value
 * @param {Map<string,object>} entities
 * @returns {object} new encounter value advanced to the next living combatant
 */
export function advanceTurn(encounter, entities) {
  const order = encounter.order || [];
  if (!order.length) return { ...encounter };

  let nextIndex = encounter.turnIndex;
  let round = encounter.round;
  let wrapped = false;
  let checked = 0;

  do {
    nextIndex = (nextIndex + 1) % order.length;
    checked++;

    // Detect wrap: we've gone from end back to start
    if (nextIndex === 0 && !wrapped) {
      wrapped = true;
      round++;
    }

    const entity = entities.get(order[nextIndex]);
    const alive = entity?.status?.alive !== false;
    if (alive) break;

    // Safety: all combatants dead — stop and return what we have
    if (checked >= order.length) break;
  } while (true);

  return {
    active: encounter.active,
    round,
    order: [...order],
    turnIndex: nextIndex,
    mode: encounter.mode,
    enemies: [...(encounter.enemies || [])],
    allies: [...(encounter.allies || [])],
  };
}

// ---- CTB timeline (C2) ----
//
// A Final Fantasy X conditional-turn-based queue: each combatant accumulates `time`
// as they act; the one with the LEAST time goes next. Faster Moves (lower cost) and
// higher speed (haste) bring an actor's next turn up sooner. PURE — same seed, same
// config ⇒ identical order. Opt-in via `rules.initiativeMode === 'timeline'`.

/** Effective speed = base speed × status speed-multiplier (haste/slow), floored > 0. */
function effSpeed(entities, id, baseSpeed) {
  return Math.max(0.01, (baseSpeed || 1) * speedMultiplier(entities, id));
}

/** Is this combatant still alive (eligible to take timeline turns)? */
function aliveIn(entities, id) {
  const e = entities.get(id);
  return !!e && (e.status || {}).alive !== false;
}

/**
 * Build a timeline encounter from allies+enemies. No initiative roll — turn order is
 * speed-driven. `rules.speedOf(entity)` supplies each combatant's base CTB speed (default 1).
 * @returns {object} encounter value with mode:'timeline', participants, turnOf, queue.
 */
export function buildTimeline({ allies, enemies }, entities, rules = {}) {
  const speedOf = typeof rules.speedOf === 'function' ? rules.speedOf : () => 1;
  const ids = [...allies, ...enemies];
  const participants = ids
    .filter(id => aliveIn(entities, id))
    .map(id => ({ id, time: 0, speed: speedOf(entities.get(id)) || 1 }));

  const enc = {
    active: true, round: 1, mode: 'timeline',
    participants, turnOf: null, queue: [],
    enemies: [...enemies], allies: [...allies],
    order: [], turnIndex: 0, // legacy fields kept null-ish for back-compat HUD/inspector
  };
  enc.turnOf = nextActor(enc);
  enc.queue = projectQueue(enc, entities, rules, 8);
  return enc;
}

/**
 * The id of the participant who acts next: least accumulated `time`.
 * Tie-break: higher speed first, then id ascending (deterministic).
 * @returns {string|null}
 */
export function nextActor(encounter) {
  const ps = encounter.participants || [];
  let best = null;
  for (const p of ps) {
    if (!best
      || p.time < best.time
      || (p.time === best.time && p.speed > best.speed)
      || (p.time === best.time && p.speed === best.speed && p.id.localeCompare(best.id) < 0)) {
      best = p;
    }
  }
  return best ? best.id : null;
}

/**
 * Charge an actor for taking a turn (time += actionCost / effectiveSpeed), prune the
 * dead, then recompute turnOf + queue. Returns a NEW encounter — never mutates input.
 * @param {object} encounter
 * @param {string} actorId
 * @param {number} actionCost — the Move's cost/rank (default 1)
 * @param {Map<string,object>} entities
 * @param {object} [rules]
 */
export function advanceTimeline(encounter, actorId, actionCost, entities, rules = {}) {
  const cost = (typeof actionCost === 'number' && actionCost > 0) ? actionCost : 1;
  let participants = (encounter.participants || []).map(p => ({ ...p }));

  const actor = participants.find(p => p.id === actorId);
  if (actor) actor.time += cost / effSpeed(entities, actorId, actor.speed);

  // Drop the dead; decrement summon lifetimes (C5) and drop expired summons.
  participants = participants
    .map(p => (p.summonTurns != null ? { ...p, summonTurns: p.id === actorId ? p.summonTurns - 1 : p.summonTurns } : p))
    .filter(p => aliveIn(entities, p.id) && (p.summonTurns == null || p.summonTurns > 0));

  const next = { ...encounter, participants };
  next.turnOf = nextActor(next);
  next.queue = projectQueue(next, entities, rules, 8);
  const minTime = participants.length ? Math.min(...participants.map(p => p.time)) : (encounter.round - 1);
  next.round = Math.floor(minTime) + 1;
  return next;
}

/**
 * Simulate forward `n` turns (no mutation) to project the visible turn bar. Assumes a
 * nominal cost of 1 per future turn (real costs aren't known yet); honors speed/haste.
 * @returns {string[]} upcoming actor ids
 */
export function projectQueue(encounter, entities, rules = {}, n = 8) {
  const sim = (encounter.participants || [])
    .filter(p => aliveIn(entities, p.id))
    .map(p => ({ ...p }));
  const out = [];
  for (let i = 0; i < n && sim.length; i++) {
    let best = sim[0];
    for (const p of sim) {
      if (p.time < best.time
        || (p.time === best.time && p.speed > best.speed)
        || (p.time === best.time && p.speed === best.speed && p.id.localeCompare(best.id) < 0)) {
        best = p;
      }
    }
    out.push(best.id);
    best.time += 1 / effSpeed(entities, best.id, best.speed);
  }
  return out;
}

/**
 * Default enemy AI (C3): pick a Move + target deterministically (no LLM). Targets the
 * living OPPONENT with the lowest hp (optionally exploiting a `rules.weaknesses` tag),
 * and uses the actor's first affordable damage/area Move (else a basic attack).
 * A ruleset may override wholesale via `rules.enemyInstinct`.
 *
 * @returns {{move:object|null, targetId:string|null}}
 */
export function enemyInstinct(actorId, encounter, entities, rng, rules = {}) {
  if (typeof rules.enemyInstinct === 'function') {
    return rules.enemyInstinct(actorId, encounter, entities, rng);
  }

  const enemies = encounter.enemies || [];
  const allies = encounter.allies || [];
  const actorIsEnemy = enemies.includes(actorId);
  const opponents = (actorIsEnemy ? allies : enemies)
    .filter(id => { const e = entities.get(id); return e && (e.status || {}).alive !== false; });

  // Lowest-hp opponent (exploit weakness tag if the ruleset declares one).
  let targetId = null, best = Infinity;
  const weaknesses = rules.weaknesses || null;
  for (const id of opponents) {
    const e = entities.get(id) || {};
    let hp = (e.stats || {}).hp ?? Infinity;
    if (weaknesses && Array.isArray((e.flags || {}).tags)) {
      if (e.flags.tags.some(t => weaknesses[t])) hp = -1; // prioritize the weak
    }
    if (hp < best) { best = hp; targetId = id; }
  }

  const moves = ((entities.get(actorId) || {}).moves || {}).list || [];
  const move = moves.find(m => m.type === 'damage' || m.type === 'area') || null;
  return { move, targetId };
}

/**
 * Should this combatant's morale break? True when its HP ratio drops below the
 * threshold OR it's the last one standing on its side. PURE.
 */
export function moraleShaken(entity, threshold = 0.34, lastStanding = false) {
  const s = (entity && entity.stats) || {};
  const ratio = s.maxHp ? (s.hp ?? 0) / s.maxHp : 1;
  return ratio < threshold || lastStanding;
}

/**
 * Map a morale decision intent to semantic ops + whether the actor leaves the fight.
 * 'fight' → keep fighting (no ops); flee/surrender/parley → drop hostility and leave. PURE.
 * @returns {{ops:object[], leaves:boolean}}
 */
export function decisionToOps(actorId, intent) {
  if (intent === 'fight') return { ops: [], leaves: false };
  return {
    ops: [
      { op: 'setFlag', id: actorId, key: 'hostile', value: false },
      { op: 'setFlag', id: actorId, key: 'morale', value: 'broken' },
    ],
    leaves: true,
  };
}

// ---- Zones & hazards (C4) ----

/** The zone a combatant occupies (default the implicit 'field'). */
export function zoneOf(entities, id) {
  const e = entities.get ? entities.get(id) : entities[id];
  return ((e && e.position) || {}).zoneId || 'field';
}

/** Does an encounter zone carry a tag (e.g. 'ledge', 'raised')? PURE. */
export function zoneHasTag(encounter, zoneId, tag) {
  const z = (encounter.zones || []).find(zz => zz.id === zoneId);
  return !!(z && Array.isArray(z.tags) && z.tags.includes(tag));
}


/**
 * Hazard ticks for one combatant at turn start: every hazard in their zone whose kind
 * has an onTick (e.g. fire) damages them. PURE — returns ops + hit descriptors.
 * @returns {{ops:object[], hits:{kind:string, zoneId:string, magnitude:number}[]}}
 */
export function hazardOps(encounter, combatantId, entities) {
  const zone = zoneOf(entities, combatantId);
  const ops = [];
  const hits = [];
  for (const h of (encounter.hazards || [])) {
    if (h.zoneId !== zone) continue;
    const def = STATUS_DEFS[h.kind];
    if (def && typeof def.onTick === 'function') {
      const res = def.onTick({ id: combatantId }, h) || {};
      if (Array.isArray(res.ops)) ops.push(...res.ops);
      hits.push({ kind: h.kind, zoneId: h.zoneId, magnitude: h.magnitude });
    }
  }
  return { ops, hits };
}

/**
 * Determine the outcome of the encounter.
 *
 * @param {object} encounter - encounter component value
 * @param {Map<string,object>} entities
 * @returns {'ongoing'|'victory'|'defeat'}
 */
export function outcome(encounter, entities) {
  const enemies = encounter.enemies || [];
  const allies = encounter.allies || [];

  const allEnemiesDead = enemies.every(id => {
    const ent = entities.get(id);
    return ent?.status?.alive === false;
  });

  const allAlliesDead = allies.every(id => {
    const ent = entities.get(id);
    return ent?.status?.alive === false;
  });

  if (allEnemiesDead) return 'victory';
  if (allAlliesDead) return 'defeat';
  return 'ongoing';
}
