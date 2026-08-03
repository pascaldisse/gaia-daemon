/**
 * campaigns/necrotopia/ruleset/necrotopia/ruleset.js
 * Necrotopia: Handbook to the Apocalypse — rules-as-data bundle.
 *
 * PURE — no server/ or client/ imports. Proves the engine is rules-agnostic a THIRD
 * way: a d6 "roll-OVER-Armor" hit + flat d6 damage, no attributes, no skills, no
 * initiative roll — on the SAME engine as 5e (d20 vs DC) and DSA5 (3d20 roll-under).
 *
 * Source mechanics (Necrotopia RPG, K.W. Dunham, 2018):
 *   - Only six-sided dice. To hit: roll 1d6, HIT if the die is strictly GREATER than
 *     the target's Armor (Armor 2 → need 3+, Armor 4 → need 5+).
 *   - Health = 25 + 1d6 at creation, +1 per level. Dead at Health <= 0.
 *   - Armor base 2. It is a to-HIT gate, not damage mitigation.
 *   - A character has exactly 3 custom Moves + 1 weapon (base 1d6 damage, +1/level).
 *   - No initiative roll — the GM announces turn order (party acts, then foes).
 *   - No XP: the GM grants a level after each session / boss (+1 Health, +1 move/upgrade).
 */

export const meta = {
  id: 'necrotopia',
  name: 'Necrotopia: Handbook to the Apocalypse',
  dice: 'd6',
  summary: 'd6 roll-OVER-Armor to hit + d6 damage. No attributes/skills; 3 custom Moves; GM-fiat.',
};

// The check the DM requests for generic narrative actions (and improvised combat
// gambits). Without this, the engine would fall back to 5e d20 ability-checks.
export const defaultCheck = {
  kind: 'necro-test',
  dcDoc: 'a difficulty from 1–6 (1=trivial, 3=risky, 4=hard, 6=near-impossible)',
  dcDefault: 4,
};

// ---- tiny self-contained dice-string parser (keeps the bundle import-free) ----

/** "2d6" → {count:2, sides:6}; unparseable → {count:1, sides:6}. */
function parseDie(die) {
  const m = /^(\d+)d(\d+)$/.exec(String(die || ''));
  if (m) return { count: Number(m[1]), sides: Number(m[2]) };
  return { count: 1, sides: 6 };
}

/** Read a combatant's Armor (the d6 hit threshold). Necrotopia base = 2. */
function armorOf(entity) {
  const s = entity && entity.stats;
  if (!s) return 2;
  return s.armor ?? s.ac ?? 2;
}

// ---- Components: Necrotopia-specific schema extensions ----

export const components = {
  // Necrotopia has NO ability scores — just Health, Armor and Level. We extend the
  // base `stats` component to teach the inspector/LLM what Armor means here.
  stats: {
    doc: 'Necrotopia core stats. Health = hp/maxHp (dead at hp<=0). Armor is the d6 hit threshold — an attacker must roll OVER it to hit. Level grants +1 Health and +1 damage. No ability scores.',
    default: { armor: 2 },
    fields: {
      armor: { doc: 'Armor — attackers must roll a d6 strictly GREATER than this to hit. Base 2; bosses/gear raise it.', range: [0, 6] },
    },
  },

  moves: {
    doc: 'Necrotopia custom Moves. A character has exactly 3. Each Move is one action: a damage attack, a heal, a buff, a stun, an area hit, or pure utility (carjacking, hacking, etc.). The GM approves new Moves on level-up.',
    default: { list: [] },
    fields: {
      list: {
        doc: 'Array of { name, type, damage?, duration?, cost?, status?, magnitude?, special? }. type ∈ damage|bleed|area|heal|buff|stun|utility|summon. damage is a die string like "1d6". duration is rounds/ticks for stuns/buffs/bleed. cost is the CTB action rank (C2; default 1). status names the applied status kind (buff/stun); magnitude its strength (bleed dmg/turn). Buffs/stuns that target ENEMIES still require a successful hit roll.',
      },
    },
  },
};

// ---- Checks: Necrotopia d6 mechanics (EXTENSION SEAM in shared/checks.js) ----

export const checks = {
  'necro-attack': {
    doc: 'Necrotopia attack — roll 1d6; HIT if the die is strictly GREATER than the target Armor (dc carries the Armor value). No criticals or fumbles.',
    dice: { count: 1, sides: 6 },
    comparator: 'gt',
    modSource() { return 0; },
    resolve(rolls, _mod, dc, _def, _ctx) {
      const roll = rolls[0];
      const armor = (dc == null ? 2 : dc);
      const success = roll > armor;
      const outcome = success ? 'HIT' : 'MISS';
      return {
        rolls, modifier: 0, total: roll, dc: armor,
        success, margin: roll - armor, crit: false, fumble: false,
        summary: `d6(${roll}) vs Armor ${armor} → ${outcome}`,
        outcome,
      };
    },
  },

  'necro-test': {
    doc: 'Necrotopia GM check (non-combat). Roll 1d6 vs a difficulty 1–6 (1=trivial … 6=near-impossible). SUCCESS if roll >= difficulty. 6 is a great success, 1 a botch. The GM picks the difficulty — there are no skills.',
    dice: { count: 1, sides: 6 },
    comparator: 'ge',
    modSource() { return 0; },
    resolve(rolls, _mod, dc, _def, _ctx) {
      const roll = rolls[0];
      const diff = Math.max(1, Math.min(6, dc || 4));
      const success = roll >= diff;
      const outcome = success ? 'SUCCESS' : 'FAILURE';
      return {
        rolls, modifier: 0, total: roll, dc: diff,
        success, margin: roll - diff, crit: roll === 6, fumble: roll === 1,
        summary: `d6(${roll}) vs difficulty ${diff} → ${outcome}`,
        outcome,
      };
    },
  },
};

// ---- Statuses (EXTENSION SEAM in shared/statuses.js) ----
//
// The Move-table effects "with teeth". The engine ticks/aggregates these; this
// bundle only supplies the data + tiny pure functions (no imports).

export const statuses = {
  // Damage-over-time: deals `magnitude` Health at the start of each of the bearer's turns.
  bleed: {
    doc: 'Bleed — deals `magnitude` damage at the start of each of the bearer\'s turns.',
    tag: 'dot',
    onTick: (t, s) => ({ ops: [{ op: 'damage', id: t.id, amount: s.magnitude || 1 }] }),
  },
  // Control: the bearer loses their turn while this is active.
  stun: { doc: 'Stun — the bearer loses their turn.', tag: 'control', skipTurn: true },
  // Buff: +2 damage on the bearer's attacks (Rage Roar).
  rage: { doc: 'Rage — +2 damage on attacks.', tag: 'buff', modifyOutgoing: () => ({ dmgDelta: 2 }) },
  // Buff: +1 effective Armor against incoming hits (Chi/armor aura).
  'armor-aura': { doc: 'Armor aura — +1 effective Armor vs incoming hits.', tag: 'buff', modifyIncoming: () => ({ armorDelta: 1 }) },
  // Buff: the bearer's attacks auto-hit (Skip Hit Rolls).
  'flawless-aim': { doc: 'Flawless aim — attacks auto-hit (skip the hit roll).', tag: 'buff', modifyOutgoing: () => ({ autoHit: true }) },
  // Debuff: -1 effective Armor on the bearer (armor-break / acid).
  'armor-break': { doc: 'Armor break — -1 effective Armor on the bearer.', tag: 'debuff', modifyIncoming: () => ({ armorDelta: -1 }) },
  // Debuff: the bearer is blinded — its attacks are far less likely to land (improv: sand in the eyes).
  blind: { doc: 'Blind — the bearer\'s attacks suffer a steep hit penalty.', tag: 'debuff', modifyOutgoing: () => ({ hitDelta: -3 }) },
  // C4 hazards (zone-scoped surfaces). fire burns everyone standing in the zone each turn;
  // oil is inert until ignited (improv: fire + oil → a bigger fire).
  fire: { doc: 'Fire — a burning surface; deals `magnitude` damage to anyone in the zone at turn start.', tag: 'dot', zoneScoped: true, onTick: (t, h) => ({ ops: [{ op: 'damage', id: t.id, amount: h.magnitude || 1 }] }) },
  oil: { doc: 'Oil — a slick, inert surface until something sets it alight.', tag: 'dot', zoneScoped: true },
  // C2 timeline: haste doubles CTB speed (acts twice as often); slow halves it.
  haste: { doc: 'Haste — ×2 CTB speed (acts sooner / more often).', tag: 'buff', modifySpeed: (sp) => sp * 2 },
  slow: { doc: 'Slow — ×0.5 CTB speed (acts later / less often).', tag: 'debuff', modifySpeed: (sp) => sp * 0.5 },
};

// ---- Combat override (EXTENSION SEAM in shared/combat.js) ----

/** Read an entity's display name (for area/move summaries). */
function nameStub(entities, id) {
  const e = entities.get(id);
  return (e && e.identity && e.identity.name) || id;
}

/** The combat zone a combatant stands in (default the implicit 'field'). */
function zoneOf(entities, id) {
  const e = entities.get(id);
  return ((e && e.position) || {}).zoneId || 'field';
}

/** Living enemies recorded on the encounter singleton (optionally only in a given zone). */
function livingEnemies(entities, zoneId) {
  const enc = (entities.get('encounter') || {}).encounter || {};
  return (enc.enemies || []).filter(id => {
    const e = entities.get(id);
    if (!e || (e.status || {}).alive === false) return false;
    if (zoneId != null && zoneOf(entities, id) !== zoneId) return false;
    return true;
  });
}

/**
 * One d6 > Armor hit roll, honoring engine-supplied status mods (armorDelta/hitDelta/autoHit).
 * @returns {{hit:boolean, roll:number|null, armor:number}}
 */
function hitRoll(entities, targetId, rng, mods = {}) {
  const armor = armorOf(entities.get(targetId)) + (mods.armorDelta || 0);
  if (mods.autoHit) return { hit: true, roll: null, armor };
  const roll = rng.d(6) + (mods.hitDelta || 0);
  return { hit: roll > armor, roll, armor };
}

/** Roll a Move's damage die + level bonus + status dmgDelta. */
function rollDamage(move, level, rng, mods = {}) {
  const die = parseDie(move.damage || '1d6');
  let total = 0;
  for (let i = 0; i < die.count; i++) total += rng.d(die.sides);
  return Math.max(1, total + Math.max(0, level - 1) + (mods.dmgDelta || 0));
}

/**
 * Necrotopia attack resolution: 1d6 > Armor to hit, then weapon/move die damage
 * (+1 per level above 1). No ability modifier, no crit-doubling. `mods` carries the
 * engine's aggregated status modifiers (rage/armor-aura/flawless-aim/…).
 */
function necroResolveAttack({ attackerId, targetId }, entities, rng, mods = {}) {
  const attacker = entities.get(attackerId);
  const target = entities.get(targetId);
  if (!attacker || !target) {
    return { hit: false, crit: false, fumble: false, attackRoll: 0, ac: 0, damage: 0, summary: 'Invalid attacker or target.', ability: '—', weaponDie: '1d6' };
  }

  const { hit, roll, armor } = hitRoll(entities, targetId, rng, mods);
  const weaponDieStr = (attacker.flags && attacker.flags.damage) || '1d6';
  let damage = 0;
  if (hit) {
    const level = (attacker.stats && attacker.stats.level) || 1;
    damage = rollDamage({ damage: weaponDieStr }, level, rng, mods);
  }

  const shown = roll == null ? 'auto' : `d6(${roll})`;
  const summary = hit
    ? `${shown} vs Armor ${armor} → HIT (${damage} damage)`
    : `${shown} vs Armor ${armor} → MISS`;

  return { hit, crit: false, fumble: false, attackRoll: roll == null ? 6 : roll, ac: armor, damage, summary, ability: '—', weaponDie: weaponDieStr };
}

/**
 * Resolve a declared Move. Routes by `move.type`:
 *   damage  — hit roll → on hit, weapon-die damage → {op:'damage'}
 *   area    — hit roll vs every living enemy → damage each
 *   heal    — roll the die → {op:'heal'} on self/ally (capped at maxHp by effects.js)
 *   buff    — applyStatus on self (no hit roll) — kind from move.status (default 'rage')
 *   stun    — hit roll → on hit applyStatus(target,'stun')
 *   bleed   — hit roll → on hit applyStatus(target,'bleed', magnitude)
 *   utility — no mechanical effect (narration carries it; C3 may route to the DM)
 *
 * @param {object} mods — engine-aggregated status modifiers
 */
function necroResolveMove(move, { actorId, targetId }, entities, rng, mods = {}) {
  const type = move.type || 'damage';
  const actor = entities.get(actorId);
  const level = (actor && actor.stats && actor.stats.level) || 1;

  if (type === 'heal') {
    const die = parseDie(move.damage || '1d6');
    let amt = 0;
    for (let i = 0; i < die.count; i++) amt += rng.d(die.sides);
    const tid = targetId || actorId;
    return { ops: [{ op: 'heal', id: tid, amount: amt }], statusOps: [], summary: `${move.name}: restores ${amt} Health`, detail: { heal: amt } };
  }

  if (type === 'buff') {
    const kind = move.status || 'rage';
    const remaining = move.duration || 2;
    const sop = { op: 'applyStatus', id: actorId, kind, remaining, source: actorId };
    if (move.magnitude != null) sop.magnitude = move.magnitude;
    return { ops: [], statusOps: [sop], summary: `${move.name}: ${kind} for ${remaining} turn(s)`, detail: { status: kind } };
  }

  if (type === 'utility') {
    return { ops: [], statusOps: [], summary: `${move.name}`, detail: { utility: true } };
  }

  if (type === 'area') {
    // Area hits every living enemy in the ACTOR's zone (C4).
    const enemies = livingEnemies(entities, zoneOf(entities, actorId));
    const ops = [];
    const parts = [];
    for (const tid of enemies) {
      const h = hitRoll(entities, tid, rng, mods);
      if (h.hit) {
        const dmg = rollDamage(move, level, rng, mods);
        ops.push({ op: 'damage', id: tid, amount: dmg });
        parts.push(`${nameStub(entities, tid)} (${dmg})`);
      } else {
        parts.push(`${nameStub(entities, tid)} (miss)`);
      }
    }
    return { ops, statusOps: [], summary: `${move.name} (area): ${parts.join(', ') || 'no targets'}`, detail: { area: true } };
  }

  // Single-target, enemy-facing: damage / stun / bleed — all gated on a hit roll.
  if (!targetId || !entities.get(targetId)) {
    return { ops: [], statusOps: [], summary: `${move.name}: no target`, detail: { hit: false } };
  }

  // C4 range: a melee Move (the default) requires the actor and target to share a zone.
  const range = move.range || 'melee';
  if (range === 'melee' && zoneOf(entities, actorId) !== zoneOf(entities, targetId)) {
    return { ops: [], statusOps: [], summary: `${move.name}: out of range — ${nameStub(entities, targetId)} is in another zone`, detail: { hit: false, outOfRange: true } };
  }

  const h = hitRoll(entities, targetId, rng, mods);
  const shown = h.roll == null ? 'auto' : `d6(${h.roll})`;
  if (!h.hit) {
    return { ops: [], statusOps: [], summary: `${move.name}: ${shown} vs Armor ${h.armor} → MISS`, detail: { hit: false } };
  }

  if (type === 'stun') {
    const remaining = move.duration || 1;
    const kind = move.status || 'stun';
    return { ops: [], statusOps: [{ op: 'applyStatus', id: targetId, kind, remaining, source: actorId }], summary: `${move.name}: ${shown} vs Armor ${h.armor} → HIT, ${kind} ${remaining}`, detail: { hit: true } };
  }
  if (type === 'bleed') {
    const remaining = move.duration || 2;
    const magnitude = move.magnitude || 2;
    return { ops: [], statusOps: [{ op: 'applyStatus', id: targetId, kind: 'bleed', magnitude, remaining, source: actorId }], summary: `${move.name}: ${shown} vs Armor ${h.armor} → HIT, bleed ${magnitude}/turn`, detail: { hit: true } };
  }

  // default: plain damage
  const dmg = rollDamage(move, level, rng, mods);
  return { ops: [{ op: 'damage', id: targetId, amount: dmg }], statusOps: [], summary: `${move.name}: ${shown} vs Armor ${h.armor} → HIT (${dmg} damage)`, detail: { hit: true, damage: dmg } };
}

// ---- Player archetypes (shared/staging.js `bindPlayerPc` reads `actorTemplates.player`
// to shape NEW party members joining in multiplayer — see docs/RULESET-AUTHORING.md).
// Four playable chassis, same flat shape as the NPC templates below (name, faction,
// accent, description, stats, moves, persona) plus a `tags` array. `player` aliases
// 'apocalypse-kid' (the authored protagonist) so an unclaimed multiplayer join gets
// the same chassis as the seeded PC; all four remain individually selectable by key.

const apocalypseKid = {
  name: 'The Apocalypse Kid', faction: 'ally', accent: '#c9463d', tags: ['pc', 'player', 'normal-speed'],
  description: 'Leather jacket, katana across the back, a wedding you were definitely not invited to. You don\'t know why the world is ending, but you intend to outlive it.',
  stats: { hp: 28, maxHp: 28, armor: 2, level: 1, xp: 0 },
  moves: {
    list: [
      { name: 'Katana Sword Slash', type: 'damage', damage: '1d6', cost: 1, special: 'Clean steel, close range.' },
      { name: 'Rage Roar', type: 'buff', status: 'rage', magnitude: 2, duration: 2, cost: 1, special: '+2 damage for 2 rounds.' },
      { name: 'Chi Healing', type: 'heal', damage: '1d6', cost: 1, special: 'Heal yourself 1d6 (cannot exceed max Health).' },
      {
        name: 'Guardian Ghost', type: 'summon', cost: 2,
        summon: {
          name: 'Guardian Ghost', hp: 10, turns: 3, damage: '1d6', accent: '#aa44ff',
          moves: [{ name: 'Spectral Slash', type: 'damage', damage: '1d6', cost: 1 }],
        },
        special: 'Summon a spectral ally that fights for 3 turns.',
      },
      { name: 'Apocalypse Now', type: 'area', damage: '3d6', cost: 2, requiresOverdrive: true, special: 'Overdrive finisher — rip the whole zone apart. Requires a full meter.' },
    ],
  },
};

const chapelChoirGirl = {
  name: 'Chapel Choir Girl', faction: 'ally', accent: '#e8d9a0', tags: ['pc', 'player', 'fast'],
  description: 'A wedding choir soloist who never got to sing her hymn — now every note she throws either heals or hurts.',
  stats: { hp: 22, maxHp: 22, armor: 1, level: 1, xp: 0 },
  moves: {
    list: [
      { name: 'Piercing Note', type: 'stun', damage: '1d3', duration: 1, cost: 1, special: 'A high, glass-cracking note that leaves ears ringing — hits for 1d3 and stuns.' },
      { name: 'Hymn of Mending', type: 'heal', damage: '1d6', cost: 1, special: 'A warm, low hymn that mends an ally for 1d6.' },
      { name: 'Crescendo', type: 'buff', status: 'rage', magnitude: 2, duration: 2, cost: 1, special: '+2 damage for 2 rounds — the choir swells behind her voice.' },
      { name: 'Hallelujah', type: 'heal', damage: '1d6', cost: 2, requiresOverdrive: true, special: 'Overdrive finisher — a soaring hymn that mends everyone within earshot (heals the party 1d6).' },
    ],
  },
};

const repoMan = {
  name: 'Repo Man', faction: 'ally', accent: '#5c6b73', tags: ['pc', 'player', 'slow'],
  description: 'A repossession agent who never got his last invoice paid — now he collects debts in blood, crowbar first.',
  stats: { hp: 32, maxHp: 32, armor: 3, level: 1, xp: 0 },
  moves: {
    list: [
      { name: 'Crowbar Smash', type: 'damage', damage: '1d6', cost: 1, special: 'A brutal swing of cold iron.' },
      { name: 'Taunt', type: 'buff', status: 'armor-aura', magnitude: 1, duration: 2, cost: 1, special: 'Draws every eye and gun his way and hunkers down — +1 effective Armor for 2 rounds.' },
      { name: 'Chain Hook', type: 'utility', cost: 1, special: 'Hurls a tow chain and yanks a foe out of position (pulls the target toward his zone) — GM adjudicated.' },
      { name: 'Repossession', type: 'damage', damage: '2d6', cost: 2, requiresOverdrive: true, special: 'Overdrive finisher — he collects everything you owe, all at once.' },
    ],
  },
};

const wastelandDrifterPc = {
  name: 'Wasteland Drifter', faction: 'ally', accent: '#8a9a5b', tags: ['pc', 'player', 'normal-speed'],
  description: 'A revolver-toting nomad who\'s crossed the wastes twice over and doesn\'t plan on stopping for anything short of the apocalypse itself.',
  stats: { hp: 25, maxHp: 25, armor: 2, level: 1, xp: 0 },
  moves: {
    list: [
      { name: 'Fan the Hammer', type: 'damage', damage: '2d3', cost: 1, special: 'Two quick shots, hip-fired (1d3 x2).' },
      { name: 'Dead Eye', type: 'buff', status: 'flawless-aim', duration: 2, cost: 1, special: 'Steadies his aim — his attacks auto-hit for 2 rounds.' },
      { name: 'Roll a Smoke', type: 'heal', damage: '1d3', cost: 1, special: 'A slow drag to steady the nerves — heals himself 1d3.' },
      { name: 'High Noon', type: 'area', damage: '1d6', cost: 2, requiresOverdrive: true, special: 'Overdrive finisher — empties the cylinder at everything still standing (1d6 to every enemy).' },
    ],
  },
};

// ---- Actor templates (DM world-first spawning — shared/staging.js consumes this) ----
//
// The DM may only narrate creatures it has SPAWNED. Each template is the stat block
// the engine stamps when the DM stages an archetype — so the LLM names "groomsman"
// and the ENGINE supplies the Health/Armor/Moves/dice. `faction` sets the default
// allegiance; `_default` catches any archetype the DM invents off-list. The four
// player archetypes above are also reachable here by key, plus `player` (the chassis
// `bindPlayerPc` stamps for a joining multiplayer party member).
export const actorTemplates = {
  'apocalypse-kid': apocalypseKid,
  'chapel-choir-girl': chapelChoirGirl,
  'repo-man': repoMan,
  'wasteland-drifter': wastelandDrifterPc,
  player: apocalypseKid,
  imp: {
    name: 'Snarling Imp', faction: 'hostile', accent: '#a64dff',
    description: 'A knee-high devil the color of a bruise, all teeth and claws.',
    stats: { hp: 4, maxHp: 4, armor: 2, level: 1, xp: 10 },
    moves: { list: [{ name: 'Claw', type: 'damage', damage: '1d3', cost: 1, special: 'Rake with filthy claws.' }] },
    persona: { personality: 'Vicious, gleeful, dumb. Attacks the nearest warm thing.', voice: 'High, scratchy — taunts in broken English.' },
  },
  groomsman: {
    name: 'Tuxedoed Groomsman', faction: 'hostile', accent: '#c94f4f',
    description: 'A wedding guest gone wrong — torn tux, black-veined eyes, moving in wrong little jerks.',
    stats: { hp: 6, maxHp: 6, armor: 2, level: 1, xp: 15 },
    moves: { list: [{ name: 'Clawing Lunge', type: 'damage', damage: '1d6', cost: 1, special: 'Rakes with broken-nailed fingers.' }] },
    persona: { personality: 'Silent, twitching, relentless. A guest who never got to sit down.', voice: 'Wet clicking; no words left.' },
  },
  preacher: {
    name: 'Shotgun Preacher', faction: 'hostile', accent: '#e0b341',
    description: 'A false officiant in a half-burned jumpsuit, a pump shotgun where a hymnal should be.',
    stats: { hp: 14, maxHp: 14, armor: 3, level: 2, xp: 40 },
    moves: { list: [{ name: 'Shotgun Blast', type: 'damage', damage: '2d6', cost: 2, special: 'A deafening point-blank roar.' }] },
    persona: { personality: 'Loud, fervent, certain the end is a sermon he gets to deliver.', voice: 'Vegas-lounge fire-and-brimstone.' },
  },
  drifter: {
    name: 'Wasteland Drifter', faction: 'neutral', accent: '#8a9a5b',
    description: 'A sun-cured survivor with wary eyes and a length of rebar for company.',
    stats: { hp: 8, maxHp: 8, armor: 2, level: 1, xp: 20 },
    moves: { list: [{ name: 'Rebar Swing', type: 'damage', damage: '1d6', cost: 1, special: 'A rusty arc of metal.' }] },
    persona: { personality: 'Cautious, transactional, not looking for a fight but ready for one.', voice: 'Low, clipped, economical.' },
  },
  _default: {
    name: 'Stranger', faction: 'neutral', accent: '#9a9a9a',
    description: 'A figure the apocalypse coughed up — unremarkable until it isn\'t.',
    stats: { hp: 5, maxHp: 5, armor: 2, level: 1, xp: 10 },
    moves: { list: [{ name: 'Desperate Strike', type: 'damage', damage: '1d3', cost: 1, special: 'A clumsy, frightened blow.' }] },
  },
};

export const combat = {
  // C2: CTB timeline — no initiative roll; turn order is speed-driven (FFX-style).
  initiativeMode: 'timeline',
  speedOf: () => 1,                 // Necrotopia: flat base speed (haste/slow reshuffle it)
  moveCost: (m) => (m && m.cost) || 1,  // action rank — lower-cost Moves come up again sooner
  resolveAttack: necroResolveAttack,
  resolveMove: necroResolveMove,
  // C3: enemies break and parley once badly hurt.
  moraleThreshold: 0.34,
  // C5: overdrive meter — fills on damage dealt/taken; a finisher Move spends a full bar.
  overdrive: { fillOnDealt: 1, fillOnTaken: 2, full: 100 },
  flavor: {
    begin: 'No more talk — weapons up. The apocalypse does not wait.',
    victory: 'The last of them comes apart in a wet heap. The ringing fades; you are still standing, somehow.',
    defeat: 'Your knees buckle and the red dark rushes in. The end of the world claims one more.',
    flee: 'You break and run, lungs burning, the snarls and gunfire dwindling behind you.',
  },
};
