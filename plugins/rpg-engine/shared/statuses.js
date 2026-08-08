/**
 * shared/statuses.js — the neutral status-effect engine (C1).
 *
 * PURE — no imports from server/ or client/. Mirrors shared/checks.js: the engine
 * ships an EMPTY default registry; rulesets register STATUS_DEFS as DATA via
 * registerStatuses(). The engine resolves status ticks/modifiers deterministically.
 *
 * A status lives on the `statuses` component: { list: [{ kind, magnitude?, remaining, source? }] }.
 *   kind      — a status id defined by a ruleset's STATUS_DEFS (e.g. "bleed","stun","rage")
 *   magnitude — strength (dmg/turn, +dmg, speed mult, …); semantics per def
 *   remaining — turns/timeline-ticks left; decremented on tick; 0 ⇒ expire
 *   source    — entity id that applied it (attribution / UI)
 *
 * A STATUS_DEF may declare:
 *   doc, tag: 'buff'|'debuff'|'dot'|'control',
 *   skipTurn?:   boolean,                 // actor's turn is skipped while active ('stun')
 *   onTick?(target, status, rng) -> { ops?:Op[], expire?:boolean },   // 'bleed' deals magnitude dmg
 *   modifyOutgoing?(ctx) -> { dmgDelta?, hitDelta?, advantage?, autoHit? },  // 'rage' (on attacker)
 *   modifyIncoming?(ctx) -> { armorDelta?, dmgTakenDelta? },          // 'armor-break'/'armor-aura' (on target)
 *   modifySpeed?(speed) -> number,        // 'haste' ×2, 'slow' ×0.5 (C2 timeline)
 *   zoneScoped?: boolean,                 // C4: hazard kinds that tick on a whole zone
 */

/** Engine ships an EMPTY default; all defs come from rulesets. */
export const STATUS_DEFS = {};

/**
 * Register status definitions from a ruleset or campaign.
 * Deep-merges into STATUS_DEFS. Pure, idempotent. Mirrors registerChecks.
 * @param {Record<string,object>} defs
 */
export function registerStatuses(defs) {
  for (const [kind, def] of Object.entries(defs || {})) {
    if (STATUS_DEFS[kind]) {
      Object.assign(STATUS_DEFS[kind], def);
    } else {
      STATUS_DEFS[kind] = { ...def };
    }
  }
}

// ---- list helpers ----

/** Normalize one status entry, dropping undefined fields. */
function normalize(s) {
  const o = { kind: s.kind, remaining: s.remaining ?? 1 };
  if (s.magnitude != null) o.magnitude = s.magnitude;
  if (s.source != null) o.source = s.source;
  return o;
}

/**
 * Return a NEW status list with `status` added. A status of the same (kind, source)
 * is refreshed (replaced) rather than stacked, so re-casting a buff just renews it.
 * @param {object[]} list — current statuses.list
 * @param {{kind:string, magnitude?:number, remaining:number, source?:string}} status
 * @returns {object[]}
 */
export function upsertStatus(list, status) {
  const src = status.source ?? null;
  const out = (list || [])
    .filter(s => !(s.kind === status.kind && (s.source ?? null) === src))
    .map(normalize);
  out.push(normalize(status));
  return out;
}

/** Read an entity's active status list (safe). */
function listOf(entities, id) {
  const comps = entities && (entities.get ? entities.get(id) : entities[id]);
  return (comps && comps.statuses && Array.isArray(comps.statuses.list)) ? comps.statuses.list : [];
}

function nameOf(entities, id) {
  const comps = entities && (entities.get ? entities.get(id) : entities[id]);
  return (comps && comps.identity && comps.identity.name) || id;
}

// ---- public API ----


/**
 * Tick all statuses on a combatant at the START of their turn:
 *  - run each def.onTick (e.g. bleed deals magnitude damage),
 *  - decrement `remaining`, drop expired (remaining hits 0 or onTick returns expire),
 *  - report whether the turn should be SKIPPED (any active skipTurn status, e.g. stun).
 *
 * Returns canonical+semantic ops (caller expands), the skip flag, and per-status
 * `lines` for broadcasting `event:system {kind:'status'}`.
 *
 * @returns {{ops:object[], skip:boolean, lines:{text:string, detail:object}[]}}
 */
export function tickStatuses(entities, combatantId, rng) {
  const list = listOf(entities, combatantId);
  const ops = [];
  const lines = [];
  let skip = false;
  if (!list.length) return { ops, skip, lines };

  const comps = entities.get ? entities.get(combatantId) : entities[combatantId];
  const target = { id: combatantId, ...(comps || {}) };
  const name = nameOf(entities, combatantId);
  const newList = [];

  for (const s of list) {
    const def = STATUS_DEFS[s.kind] || {};
    let expired = false;

    if (typeof def.onTick === 'function') {
      const res = def.onTick(target, s, rng) || {};
      if (Array.isArray(res.ops)) ops.push(...res.ops);
      if (res.expire) expired = true;
    }
    if (def.skipTurn) skip = true;

    const remaining = (s.remaining ?? 1) - 1;
    if (!expired && remaining > 0) {
      const kept = normalize({ ...s, remaining });
      newList.push(kept);
      lines.push({
        text: `${name}: ${s.kind}${s.magnitude != null ? ` (${s.magnitude})` : ''} — ${remaining} left`,
        detail: { target: combatantId, kind: s.kind, magnitude: s.magnitude, remaining },
      });
    } else {
      lines.push({
        text: `${name}: ${s.kind} fades`,
        detail: { target: combatantId, kind: s.kind, remaining: 0, expired: true },
      });
    }
  }

  ops.push({ op: 'merge', id: combatantId, component: 'statuses', value: { list: newList } });
  return { ops, skip, lines };
}

/**
 * Sum the attack-time modifiers from the attacker's outgoing statuses and the
 * target's incoming statuses. Resolvers call this and apply the deltas to their math.
 * @returns {{dmgDelta:number, hitDelta:number, armorDelta:number, dmgTakenDelta:number, advantage:boolean, autoHit:boolean}}
 */
export function aggregateModifiers(entities, attackerId, targetId) {
  const acc = { dmgDelta: 0, hitDelta: 0, armorDelta: 0, dmgTakenDelta: 0, advantage: false, autoHit: false };

  for (const s of listOf(entities, attackerId)) {
    const def = STATUS_DEFS[s.kind];
    if (def && typeof def.modifyOutgoing === 'function') {
      const m = def.modifyOutgoing({ attackerId, targetId, status: s, entities }) || {};
      if (m.dmgDelta) acc.dmgDelta += m.dmgDelta;
      if (m.hitDelta) acc.hitDelta += m.hitDelta;
      if (m.advantage) acc.advantage = true;
      if (m.autoHit) acc.autoHit = true;
    }
  }
  for (const s of listOf(entities, targetId)) {
    const def = STATUS_DEFS[s.kind];
    if (def && typeof def.modifyIncoming === 'function') {
      const m = def.modifyIncoming({ attackerId, targetId, status: s, entities }) || {};
      if (m.armorDelta) acc.armorDelta += m.armorDelta;
      if (m.dmgTakenDelta) acc.dmgTakenDelta += m.dmgTakenDelta;
    }
  }
  return acc;
}

/**
 * Product of modifySpeed over a combatant's active statuses (C2 timeline).
 * haste ×2, slow ×0.5; defaults to 1 when none apply.
 * @returns {number}
 */
export function speedMultiplier(entities, combatantId) {
  let mult = 1;
  for (const s of listOf(entities, combatantId)) {
    const def = STATUS_DEFS[s.kind];
    if (def && typeof def.modifySpeed === 'function') {
      const next = def.modifySpeed(mult, s);
      if (typeof next === 'number' && next > 0) mult = next;
    }
  }
  return mult;
}
