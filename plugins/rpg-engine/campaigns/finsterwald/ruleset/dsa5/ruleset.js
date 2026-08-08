/**
 * campaigns/finsterwald/ruleset/dsa5/ruleset.js
 * DSA-style (Das Schwarze Auge, 5th-edition mechanics) — rules-as-data bundle.
 *
 * PURE — no server/ or client/ imports. This is the engine's adversarial proof:
 * a roll-UNDER 3d20 system with eight attributes, skill-point compensation and
 * quality levels — mechanically opposite to 5e (d20-over-DC) and Necrotopia
 * (d6-over-Armor) — running on the SAME seams.
 *
 * Mechanics implemented (game rules are not copyrightable; all text here is ours):
 *   - Eight Eigenschaften: MU KL IN CH FF GE KO KK (typically 8–14).
 *   - Talentprobe: roll 3d20 against a talent's three linked attributes. Each die
 *     that comes up ABOVE its attribute must be bought down with Fertigkeitswert
 *     (FW) points. If the total overage exceeds FW, the probe fails. Leftover FW
 *     points become Qualitätsstufen: QS = ceil(remaining/3), min 1, max 6.
 *   - Erschwernis/Erleichterung: the dc field is a signed modifier (-3 easy … +5
 *     brutal, 0 = normal) applied to all three attributes for that probe.
 *   - Two 1s = critical success (auto-success). Two 20s = botch (auto-failure).
 *   - Eigenschaftsprobe: 1d20 roll-under a single attribute.
 *   - Combat: Attacke 1d20 ≤ AT to hit (1 crits, 20 botches); the defender rolls
 *     Parade 1d20 ≤ PA to negate (crits cannot be parried). Damage = weapon TP
 *     (e.g. "1d6+2") minus the target's Rüstungsschutz (RS). LeP = hp/maxHp.
 *   - Initiative: INI drives the CTB timeline (faster heroes act more often).
 */

export const meta = {
  id: 'dsa5',
  name: 'Das Schwarze Auge (5. Edition Mechanik)',
  dice: '3W20',
  summary: 'Roll-under 3d20 Talentproben with FW compensation and QS; AT/PA/RS combat; eight Eigenschaften.',
};

// The check the DM requests for generic narrative actions. dc is a signed
// Erschwernis, NOT a target number — 0 is a normal probe. The shape teaches the
// LLM to name the Talent so the bundle can pick the right attribute triple.
export const defaultCheck = {
  kind: 'talent-probe',
  dcDoc: 'a signed Erschwernis from -3 (leicht) to +5 (fast unmöglich); 0 = normal probe',
  dcDefault: 0,
  shape: '{check:"talent-probe", skill:"<Talent, e.g. Sinnesschärfe|Klettern|Schleichen|Überreden|Einschüchtern|Fährtensuchen|Kraftakt|Körperbeherrschung>", dc, reason}',
};

// ---- tiny self-contained helpers (keep the bundle import-free) ----

/** "1d6+4" / "2d6" / "1d6-1" → {count, sides, plus}. Unparseable → 1d6+0. */
function parseTp(die) {
  const m = /^(\d+)[dw](\d+)\s*([+-]\s*\d+)?$/i.exec(String(die || '').trim());
  if (!m) return { count: 1, sides: 6, plus: 0 };
  return { count: Number(m[1]), sides: Number(m[2]), plus: m[3] ? Number(m[3].replace(/\s/g, '')) : 0 };
}

/** Roll a TP die string. */
function rollTp(die, rng) {
  const { count, sides, plus } = parseTp(die);
  let total = plus;
  for (let i = 0; i < count; i++) total += rng.d(sides);
  return Math.max(0, total);
}

/** Case-insensitive attribute read: attrValue(stats,'MU') → stats.mu ?? stats.MU ?? 10. */
function attrValue(stats, key) {
  if (!stats) return 10;
  const k = String(key || '').toLowerCase();
  return stats[k] ?? stats[k.toUpperCase()] ?? 10;
}

/** The standard talents and their attribute triples. Unknown talents fall back to MU/KL/IN at FW 0. */
const TALENTE = {
  'sinnesschärfe': ['KL', 'IN', 'IN'],
  'klettern': ['MU', 'GE', 'KK'],
  'körperbeherrschung': ['GE', 'GE', 'KO'],
  'kraftakt': ['KO', 'KK', 'KK'],
  'schleichen': ['MU', 'IN', 'GE'],
  'verbergen': ['MU', 'IN', 'GE'],
  'überreden': ['MU', 'KL', 'CH'],
  'betören': ['MU', 'CH', 'CH'],
  'einschüchtern': ['MU', 'IN', 'CH'],
  'menschenkenntnis': ['KL', 'IN', 'CH'],
  'heilkunde': ['KL', 'CH', 'FF'],
  'wildnisleben': ['MU', 'GE', 'KO'],
  'fährtensuchen': ['MU', 'IN', 'GE'],
  'taschendiebstahl': ['MU', 'FF', 'GE'],
  'schwimmen': ['GE', 'KO', 'KK'],
  'zechen': ['KL', 'KO', 'KK'],
  'götter & kulte': ['KL', 'KL', 'IN'],
  'sagen & legenden': ['KL', 'KL', 'IN'],
  'orientierung': ['KL', 'IN', 'IN'],
  'pflanzenkunde': ['KL', 'FF', 'KO'],
  'tierkunde': ['MU', 'MU', 'CH'],
  'fesseln': ['KL', 'FF', 'KK'],
  'reiten': ['CH', 'GE', 'KK'],
  'handel': ['KL', 'IN', 'CH'],
  // English aliases — a model thinking in 5e skill names still lands on the right triple.
  'perception': ['KL', 'IN', 'IN'],
  'stealth': ['MU', 'IN', 'GE'],
  'athletics': ['MU', 'GE', 'KK'],
  'acrobatics': ['GE', 'GE', 'KO'],
  'persuasion': ['MU', 'KL', 'CH'],
  'intimidation': ['MU', 'IN', 'CH'],
  'insight': ['KL', 'IN', 'CH'],
  'survival': ['MU', 'GE', 'KO'],
  'investigation': ['KL', 'IN', 'IN'],
  'medicine': ['KL', 'CH', 'FF'],
  'nature': ['KL', 'FF', 'KO'],
  'history': ['KL', 'KL', 'IN'],
  'religion': ['KL', 'KL', 'IN'],
  'climbing': ['MU', 'GE', 'KK'],
  'swimming': ['GE', 'KO', 'KK'],
  'tracking': ['MU', 'IN', 'GE'],
};

/** Look up a talent's attribute triple + the actor's FW for it. */
function talentOf(stats, skillName) {
  const name = String(skillName || '').trim();
  const attrs = TALENTE[name.toLowerCase()] || ['MU', 'KL', 'IN'];
  const table = (stats && stats.talente) || {};
  // FW lookup is case-insensitive so "schleichen" finds "Schleichen".
  let fw = 0;
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === name.toLowerCase()) { fw = Number(v) || 0; break; }
  }
  return { name: name || 'Talentprobe', attrs, fw };
}

/** Clamp a dc into the sane Erschwernis range. */
function erschwernisOf(dc) {
  if (dc == null || Number.isNaN(Number(dc))) return 0;
  return Math.max(-5, Math.min(5, Number(dc)));
}

/** Quality levels from leftover FW points: 0–3 → QS1 … 16+ → QS6. */
function qsOf(fpLeft) {
  return Math.max(1, Math.min(6, Math.ceil(Math.max(fpLeft, 1) / 3)));
}

// ---- Components: DSA-specific schema extensions ----

export const components = {
  stats: {
    doc: 'DSA hero values. LeP (life) = hp/maxHp, dead at hp<=0. Eight Eigenschaften mu/kl/in/ch/ff/ge/ko/kk (8–14 typical). at/pa = Attacke/Parade combat values (1d20 roll-under). rs = Rüstungsschutz, subtracted from damage. ini drives turn order. talente maps Talent name → Fertigkeitswert (FW).',
    default: { rs: 0, ini: 8 },
    fields: {
      mu: { doc: 'Mut — courage, willpower.', range: [1, 20] },
      kl: { doc: 'Klugheit — logic, learning.', range: [1, 20] },
      in: { doc: 'Intuition — instinct, perception.', range: [1, 20] },
      ch: { doc: 'Charisma — presence, magnetism.', range: [1, 20] },
      ff: { doc: 'Fingerfertigkeit — fine motor skill.', range: [1, 20] },
      ge: { doc: 'Gewandtheit — agility.', range: [1, 20] },
      ko: { doc: 'Konstitution — toughness.', range: [1, 20] },
      kk: { doc: 'Körperkraft — raw strength.', range: [1, 20] },
      at: { doc: 'Attacke — roll 1d20 ≤ AT to hit.', range: [1, 20] },
      pa: { doc: 'Parade — roll 1d20 ≤ PA to parry an incoming hit.', range: [1, 20] },
      rs: { doc: 'Rüstungsschutz — armor, subtracted from incoming damage.', range: [0, 8] },
      ini: { doc: 'Initiative — CTB speed; higher acts sooner and more often.', range: [1, 20] },
      talente: { doc: 'Map of Talent name → FW (Fertigkeitswert 0–20), e.g. {"Schleichen": 5}.' },
    },
  },

  moves: {
    doc: 'DSA combat maneuvers. Each is one action: a weapon strike (damage, TP like "1d6+2"), a mighty blow, a bandage (heal), a feint (stun), etc. Attacks resolve as Attacke 1d20≤AT, then the defender may parry (1d20≤PA); damage is TP minus RS.',
    default: { list: [] },
    fields: {
      list: { doc: 'Array of { name, type, damage?, duration?, cost?, status?, magnitude?, special? }. type ∈ damage|bleed|area|heal|buff|stun|utility. damage is a TP string like "1d6+2".' },
    },
  },
};

// ---- Checks: the 3d20 machinery (EXTENSION SEAM in shared/checks.js) ----

export const checks = {
  'talent-probe': {
    doc: 'DSA Talentprobe — 3d20 roll-under the talent\'s three attributes; each die above its (Erschwernis-adjusted) attribute costs FW points; leftover FW → QS 1–6. Two 1s crit, two 20s botch. dc is the signed Erschwernis (-3…+5, 0 normal). The talent name rides in `skill`.',
    dice: { count: 3, sides: 20 },
    comparator: 'le',
    modSource(ctx) {
      return talentOf(ctx.stats, ctx.skill).fw;
    },
    resolve(rolls, _mod, dc, _def, ctx) {
      const { name, attrs, fw } = talentOf(ctx && ctx.stats, ctx && ctx.skill);
      const ersch = erschwernisOf(dc);
      const effective = attrs.map((a) => attrValue(ctx && ctx.stats, a) - ersch);
      const overage = rolls.reduce((sum, roll, i) => sum + Math.max(0, roll - effective[i]), 0);
      const fpLeft = fw - overage;
      const ones = rolls.filter((r) => r === 1).length;
      const twenties = rolls.filter((r) => r === 20).length;
      const crit = ones >= 2;
      const fumble = twenties >= 2;
      const success = fumble ? false : (crit || fpLeft >= 0);
      const qs = success ? qsOf(fpLeft) : 0;
      const outcome = crit ? `MEISTERLICH (QS ${qs})`
        : fumble ? 'PATZER'
        : success ? `GELUNGEN (QS ${qs})`
        : 'MISSLUNGEN';
      const dice = rolls.map((r, i) => `${r}≤${effective[i]}${r > effective[i] ? '✗' : ''}`).join(' ');
      const erschTxt = ersch === 0 ? '' : ` (Erschwernis ${ersch > 0 ? '+' : ''}${ersch})`;
      return {
        rolls, modifier: fw, total: fpLeft, dc: ersch,
        success, margin: fpLeft, crit, fumble, qs,
        summary: `${name}${erschTxt} [${attrs.join('/')}]: 3W20 ${dice}, FW ${fw} → ${outcome}`,
        outcome,
      };
    },
  },

  'eigenschafts-probe': {
    doc: 'DSA Eigenschaftsprobe — 1d20 roll-under a single attribute (name it in `ability`, e.g. "MU"). dc is a signed Erschwernis. 1 crits, 20 botches.',
    dice: { count: 1, sides: 20 },
    comparator: 'le',
    modSource(ctx) {
      return attrValue(ctx.stats, ctx.ability || 'MU');
    },
    resolve(rolls, mod, dc, _def, ctx) {
      const roll = rolls[0];
      const attr = String((ctx && ctx.ability) || 'MU').toUpperCase();
      const target = mod - erschwernisOf(dc);
      const crit = roll === 1;
      const fumble = roll === 20;
      const success = fumble ? false : (crit || roll <= target);
      const outcome = crit ? 'MEISTERLICH' : fumble ? 'PATZER' : success ? 'GELUNGEN' : 'MISSLUNGEN';
      return {
        rolls, modifier: mod, total: roll, dc: erschwernisOf(dc),
        success, margin: target - roll, crit, fumble,
        summary: `${attr}-Probe: W20(${roll}) ≤ ${target} → ${outcome}`,
        outcome,
      };
    },
  },
};

// ---- Statuses (EXTENSION SEAM in shared/statuses.js) ----

export const statuses = {
  blutung: {
    doc: 'Blutung — loses `magnitude` LeP at the start of each of the bearer\'s turns.',
    tag: 'dot',
    onTick: (t, s) => ({ ops: [{ op: 'damage', id: t.id, amount: s.magnitude || 1 }] }),
  },
  betäubt: { doc: 'Betäubt — the bearer loses their turn.', tag: 'control', skipTurn: true },
  kampfrausch: { doc: 'Kampfrausch — +2 TP on the bearer\'s attacks.', tag: 'buff', modifyOutgoing: () => ({ dmgDelta: 2 }) },
  deckung: { doc: 'Deckung — +1 effective RS against incoming hits.', tag: 'buff', modifyIncoming: () => ({ armorDelta: 1 }) },
  furcht: { doc: 'Furcht — the bearer attacks at -2 AT.', tag: 'debuff', modifyOutgoing: () => ({ hitDelta: -2 }) },
  // Zone hazards for improvised actions (register the English kind too so an
  // LLM emitting spawnHazard{kind:"fire"} lands on the same behavior).
  feuer: { doc: 'Feuer — a burning surface; `magnitude` damage to anyone in the zone at turn start.', tag: 'dot', zoneScoped: true, onTick: (t, h) => ({ ops: [{ op: 'damage', id: t.id, amount: h.magnitude || 1 }] }) },
  fire: { doc: 'Fire — alias of feuer.', tag: 'dot', zoneScoped: true, onTick: (t, h) => ({ ops: [{ op: 'damage', id: t.id, amount: h.magnitude || 1 }] }) },
};

// ---- Combat override (EXTENSION SEAM consumed by server/combat.js) ----

function nameStub(entities, id) {
  const e = entities.get(id);
  return (e && e.identity && e.identity.name) || id;
}

function zoneOf(entities, id) {
  const e = entities.get(id);
  return ((e && e.position) || {}).zoneId || 'field';
}

function livingEnemies(entities, zoneId) {
  const enc = (entities.get('encounter') || {}).encounter || {};
  return (enc.enemies || []).filter((id) => {
    const e = entities.get(id);
    if (!e || (e.status || {}).alive === false) return false;
    if (zoneId != null && zoneOf(entities, id) !== zoneId) return false;
    return true;
  });
}

/**
 * Attacke → Parade → TP−RS. `mods` carries engine-aggregated status modifiers:
 * hitDelta shifts the attacker's AT, armorDelta the target's RS, dmgDelta the TP,
 * autoHit skips the AT roll (crits can still not be parried; autoHit can).
 * @returns {{hit:boolean, crit:boolean, parried:boolean, atRoll:number|null, paRoll:number|null, damage:number}}
 */
function dsaStrike(entities, attackerId, targetId, tpString, rng, mods = {}) {
  const attacker = entities.get(attackerId) || {};
  const target = entities.get(targetId) || {};
  const at = ((attacker.stats || {}).at || 10) + (mods.hitDelta || 0);
  const pa = (target.stats || {}).pa || 0;
  const rs = Math.max(0, ((target.stats || {}).rs || 0) + (mods.armorDelta || 0));

  let atRoll = null;
  let crit = false;
  if (!mods.autoHit) {
    atRoll = rng.d(20);
    if (atRoll === 20) return { hit: false, crit: false, parried: false, atRoll, paRoll: null, damage: 0, at, pa, rs };
    crit = atRoll === 1;
    if (!crit && atRoll > at) return { hit: false, crit: false, parried: false, atRoll, paRoll: null, damage: 0, at, pa, rs };
  }

  // Parade — the defender's roll, negates a normal hit. Crits cannot be parried.
  let paRoll = null;
  if (!crit && pa > 0 && (target.status || {}).alive !== false) {
    paRoll = rng.d(20);
    if (paRoll !== 20 && paRoll <= pa) {
      return { hit: false, crit: false, parried: true, atRoll, paRoll, damage: 0, at, pa, rs };
    }
  }

  let tp = rollTp(tpString, rng) + (mods.dmgDelta || 0);
  if (crit) tp *= 2;
  const damage = Math.max(0, tp - rs);
  return { hit: true, crit, parried: false, atRoll, paRoll, damage, at, pa, rs };
}

/** Human-readable strike summary: "AT W20(7)≤12 → Treffer; Parade W20(15)>9 durchbrochen; 6 TP − 1 RS = 5 SP". */
function strikeSummary(s, moveName) {
  const lead = moveName ? `${moveName}: ` : '';
  const atTxt = s.atRoll == null ? 'AT auto' : `AT W20(${s.atRoll})≤${s.at}`;
  if (s.atRoll === 20) return `${lead}${atTxt} → PATZER`;
  if (!s.hit && !s.parried) return `${lead}${atTxt} → verfehlt`;
  if (s.parried) return `${lead}${atTxt} → Treffer, doch Parade W20(${s.paRoll})≤${s.pa} → pariert`;
  const paTxt = s.paRoll == null ? '' : ` Parade W20(${s.paRoll})>${s.pa} durchbrochen;`;
  const critTxt = s.crit ? ' MEISTERLICHE ATTACKE (TP ×2)!' : '';
  return `${lead}${atTxt} → Treffer;${paTxt}${critTxt} ${s.damage} SP (nach ${s.rs} RS)`;
}

function dsaResolveAttack({ attackerId, targetId }, entities, rng, mods = {}) {
  const attacker = entities.get(attackerId);
  const target = entities.get(targetId);
  if (!attacker || !target) {
    return { hit: false, crit: false, fumble: false, attackRoll: 0, ac: 0, damage: 0, summary: 'Invalid attacker or target.', ability: '—', weaponDie: '1d6' };
  }
  const tpString = (attacker.flags && attacker.flags.damage) || '1d6';
  const s = dsaStrike(entities, attackerId, targetId, tpString, rng, mods);
  return {
    hit: s.hit, crit: s.crit, fumble: s.atRoll === 20,
    attackRoll: s.atRoll == null ? 1 : s.atRoll, ac: s.at, damage: s.damage,
    summary: strikeSummary(s, null), ability: 'AT', weaponDie: tpString,
  };
}

function dsaResolveMove(move, { actorId, targetId }, entities, rng, mods = {}) {
  const type = move.type || 'damage';

  if (type === 'heal') {
    const amt = rollTp(move.damage || '1d6', rng);
    const tid = targetId || actorId;
    return { ops: [{ op: 'heal', id: tid, amount: amt }], statusOps: [], summary: `${move.name}: ${amt} LeP zurückgewonnen`, detail: { heal: amt } };
  }

  if (type === 'buff') {
    const kind = move.status || 'kampfrausch';
    const remaining = move.duration || 2;
    const sop = { op: 'applyStatus', id: actorId, kind, remaining, source: actorId };
    if (move.magnitude != null) sop.magnitude = move.magnitude;
    return { ops: [], statusOps: [sop], summary: `${move.name}: ${kind} für ${remaining} Runde(n)`, detail: { status: kind } };
  }

  if (type === 'utility') {
    return { ops: [], statusOps: [], summary: `${move.name}`, detail: { utility: true } };
  }

  if (type === 'area') {
    const enemies = livingEnemies(entities, zoneOf(entities, actorId));
    const ops = [];
    const parts = [];
    for (const tid of enemies) {
      const s = dsaStrike(entities, actorId, tid, move.damage || '1d6', rng, mods);
      if (s.hit) {
        ops.push({ op: 'damage', id: tid, amount: s.damage });
        parts.push(`${nameStub(entities, tid)} (${s.damage} SP)`);
      } else {
        parts.push(`${nameStub(entities, tid)} (${s.parried ? 'pariert' : 'verfehlt'})`);
      }
    }
    return { ops, statusOps: [], summary: `${move.name} (Rundumschlag): ${parts.join(', ') || 'keine Gegner'}`, detail: { area: true } };
  }

  // Single-target, enemy-facing: damage / stun / bleed — gated on Attacke vs Parade.
  if (!targetId || !entities.get(targetId)) {
    return { ops: [], statusOps: [], summary: `${move.name}: kein Ziel`, detail: { hit: false } };
  }
  const range = move.range || 'melee';
  if (range === 'melee' && zoneOf(entities, actorId) !== zoneOf(entities, targetId)) {
    return { ops: [], statusOps: [], summary: `${move.name}: außer Reichweite — ${nameStub(entities, targetId)} steht in einer anderen Zone`, detail: { hit: false, outOfRange: true } };
  }

  const s = dsaStrike(entities, actorId, targetId, move.damage || '1d6', rng, mods);
  if (!s.hit) {
    return { ops: [], statusOps: [], summary: strikeSummary(s, move.name), detail: { hit: false, parried: s.parried } };
  }
  if (type === 'stun') {
    const remaining = move.duration || 1;
    return { ops: [], statusOps: [{ op: 'applyStatus', id: targetId, kind: move.status || 'betäubt', remaining, source: actorId }], summary: `${strikeSummary(s, move.name)} — Ziel betäubt (${remaining})`, detail: { hit: true } };
  }
  if (type === 'bleed') {
    const remaining = move.duration || 2;
    const magnitude = move.magnitude || 2;
    return { ops: [], statusOps: [{ op: 'applyStatus', id: targetId, kind: 'blutung', magnitude, remaining, source: actorId }], summary: `${strikeSummary(s, move.name)} — Blutung ${magnitude}/Runde`, detail: { hit: true } };
  }
  return { ops: [{ op: 'damage', id: targetId, amount: s.damage }], statusOps: [], summary: strikeSummary(s, move.name), detail: { hit: true, damage: s.damage, crit: s.crit } };
}

export const combat = {
  initiativeMode: 'timeline',
  speedOf: (entity) => ((entity && entity.stats) || {}).ini || 8,
  moveCost: (m) => (m && m.cost) || 1,
  resolveAttack: dsaResolveAttack,
  resolveMove: dsaResolveMove,
  moraleThreshold: 0.3,
  overdrive: { fillOnDealt: 1, fillOnTaken: 2, full: 100 },
  flavor: {
    begin: 'Stahl wird gezogen — die Zeit der Worte ist vorbei.',
    victory: 'Der letzte Gegner sinkt zu Boden. Der Finsterwald hält den Atem an — ihr habt gesiegt.',
    defeat: 'Die Welt kippt ins Schwarze. Boron breitet seinen Mantel über euch.',
    flee: 'Ihr weicht zurück und rennt — Zweige peitschen, das Geheul verklingt hinter euch.',
  },
};

// ---- Actor templates (DM world-first spawning — shared/staging.js consumes this) ----

export const actorTemplates = {
  goblin: {
    name: 'Goblin', faction: 'hostile', accent: '#7a9a3b',
    description: 'A wiry, red-furred goblin with yellow eyes and a crude club, all spite and hunger.',
    stats: { hp: 8, maxHp: 8, mu: 10, kl: 8, in: 12, ch: 8, ff: 11, ge: 12, ko: 11, kk: 10, at: 10, pa: 6, rs: 1, ini: 11, level: 1, xp: 25 },
    moves: { list: [{ name: 'Knüppelhieb', type: 'damage', damage: '1d6', cost: 1, special: 'A crude club swung with spite.' }] },
    persona: { personality: 'Cowardly in the open, vicious in a pack. Screeches to its kin when hurt.', voice: 'Shrill Garethi fragments — "Rrricht! Weg da!"' },
  },
  wolf: {
    name: 'Finsterwald-Wolf', faction: 'hostile', accent: '#5b6a7a',
    description: 'A gaunt grey wolf of the deep woods, ribs showing, eyes like wet amber.',
    stats: { hp: 12, maxHp: 12, mu: 12, kl: 6, in: 14, ch: 8, ff: 8, ge: 14, ko: 12, kk: 12, at: 12, pa: 8, rs: 0, ini: 14, level: 1, xp: 35 },
    moves: { list: [{ name: 'Biss', type: 'damage', damage: '1d6+1', cost: 1, special: 'Snapping jaws going for the hamstring.' }] },
    persona: { personality: 'Patient, circling, testing for weakness.', voice: 'Low growls; no words.' },
  },
  räuber: {
    name: 'Wegelagerer', faction: 'hostile', accent: '#a0522d',
    description: 'A road bandit in a patched gambeson, sabre notched from bad decisions.',
    stats: { hp: 14, maxHp: 14, mu: 12, kl: 10, in: 11, ch: 9, ff: 11, ge: 12, ko: 12, kk: 12, at: 12, pa: 10, rs: 1, ini: 12, level: 2, xp: 50 },
    moves: { list: [{ name: 'Säbelhieb', type: 'damage', damage: '1d6+2', cost: 1, special: 'A practiced, dirty cut.' }] },
    persona: { personality: 'Greedy but pragmatic — fights for coin, flees for free.', voice: 'Rough lowland Garethi, all threat and bluster.' },
  },
  ork: {
    name: 'Ork-Plünderer', faction: 'hostile', accent: '#3f5a36',
    description: 'A black-furred orc raider, tusks filed sharp, shoulders like a draft horse.',
    stats: { hp: 20, maxHp: 20, mu: 13, kl: 8, in: 10, ch: 7, ff: 9, ge: 11, ko: 14, kk: 15, at: 13, pa: 9, rs: 2, ini: 10, level: 3, xp: 80 },
    moves: { list: [{ name: 'Axtschlag', type: 'damage', damage: '1d6+3', cost: 2, special: 'A two-handed arc that splits shields.' }] },
    persona: { personality: 'Direct, brutal, honors strength and nothing else.', voice: 'Guttural, broken Garethi.' },
  },
  dorfbewohner: {
    name: 'Dorfbewohner', faction: 'neutral', accent: '#b8a06a',
    description: 'A weather-worn villager of Weyhersbrunn in wool and mud-caked boots.',
    stats: { hp: 10, maxHp: 10, mu: 10, kl: 10, in: 11, ch: 10, ff: 11, ge: 10, ko: 11, kk: 11, at: 8, pa: 6, rs: 0, ini: 9, level: 1, xp: 10 },
    moves: { list: [{ name: 'Heugabel', type: 'damage', damage: '1d6-1', cost: 1, special: 'A farm tool held like a prayer.' }] },
    persona: { personality: 'Superstitious, wary of the forest, warm once trust is earned.', voice: 'Rural Garethi drawl.' },
  },
  // For multiplayer: new party members get a young-adventurer chassis.
  player: {
    stats: { hp: 28, maxHp: 28, mu: 12, kl: 11, in: 12, ch: 11, ff: 11, ge: 12, ko: 12, kk: 12, at: 11, pa: 8, rs: 1, ini: 11, level: 1, xp: 0, talente: { 'Sinnesschärfe': 4, 'Klettern': 3, 'Schleichen': 4, 'Überreden': 3, 'Wildnisleben': 3 } },
    moves: { list: [
      { name: 'Schwerthieb', type: 'damage', damage: '1d6+2', cost: 1, special: 'A clean cut with the arming sword.' },
      { name: 'Wuchtschlag', type: 'damage', damage: '1d6+4', cost: 2, special: 'Everything behind one blow.' },
      { name: 'Verband anlegen', type: 'heal', damage: '1d6', cost: 2, special: 'Field dressing — recover 1d6 LeP.' },
    ] },
    flags: { damage: '1d6+2' },
  },
  _default: {
    name: 'Fremde Gestalt', faction: 'neutral', accent: '#9a9a9a',
    description: 'A stranger the road washed into Weyhersbrunn — unremarkable until they aren\'t.',
    stats: { hp: 10, maxHp: 10, mu: 10, kl: 10, in: 10, ch: 10, ff: 10, ge: 10, ko: 10, kk: 10, at: 9, pa: 7, rs: 0, ini: 9, level: 1, xp: 15 },
    moves: { list: [{ name: 'Dolchstoß', type: 'damage', damage: '1d3', cost: 1, special: 'A quick, desperate jab.' }] },
  },
};
