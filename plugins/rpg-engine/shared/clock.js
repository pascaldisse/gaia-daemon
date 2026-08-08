/**
 * shared/clock.js — the world clock (PURE): 4-phase days + NPC schedules.
 *
 * The breathing world's deterministic half. Time lives on the `world-state`
 * singleton as `clock: {day, phase, ticks}`; every world action ticks it, and
 * every TICKS_PER_PHASE ticks the phase turns (morning → afternoon → evening →
 * night → next day). Phase changes move scheduled NPCs and surface a location's
 * ambient line — no LLM required for the world to feel inhabited. The DM (human
 * or LLM) layers staged beats ON TOP via the existing staging path.
 *
 * Authoring:
 *   - NPC `schedule` component: { morning: 'loc-inn', evening: 'loc-square', … }
 *     (phases may be omitted — the NPC stays put).
 *   - Location `flags.ambient`: { evening: ["Lamplighters make their rounds."], … }
 *     or a plain array used for every phase.
 *
 * PURE — no imports from server/ or client/; the server applies the ops.
 */

export const PHASES = ['morning', 'afternoon', 'evening', 'night'];

/** World actions per phase — a day is 4 phases = 24 actions. */
export const TICKS_PER_PHASE = 6;

/** Flavor lines for the phase-change banner (per phase). */
const PHASE_BANNERS = {
  morning: 'Morning light finds the world again.',
  afternoon: 'The day leans into afternoon.',
  evening: 'Evening falls; shadows grow long.',
  night: 'Night settles in, deep and watchful.',
};

/** Read the clock off the world-state components (defaults for older saves). */
export function clockOf(worldState) {
  const c = (worldState && worldState.clock) || {};
  return {
    day: c.day || 1,
    phase: PHASES.includes(c.phase) ? c.phase : 'morning',
    ticks: c.ticks || 0,
  };
}

/** One-line context string for prompts: "Day 2, evening." */
export function clockLine(worldState) {
  const c = clockOf(worldState);
  return `Day ${c.day}, ${c.phase}`;
}

/**
 * Advance the clock by one tick. Returns the new clock and whether the PHASE
 * rolled over (the moment the world breathes).
 * @returns {{clock: {day:number, phase:string, ticks:number}, phaseChanged: boolean}}
 */
export function tick(worldState) {
  const c = clockOf(worldState);
  const ticks = c.ticks + 1;
  if (ticks < TICKS_PER_PHASE) {
    return { clock: { ...c, ticks }, phaseChanged: false };
  }
  const idx = PHASES.indexOf(c.phase);
  const nextPhase = PHASES[(idx + 1) % PHASES.length];
  const day = nextPhase === 'morning' ? c.day + 1 : c.day;
  return { clock: { day, phase: nextPhase, ticks: 0 }, phaseChanged: true };
}

/** The banner line announcing a new phase. */
export function phaseBanner(clock) {
  const base = PHASE_BANNERS[clock.phase] || `The ${clock.phase} comes.`;
  return clock.phase === 'morning' ? `Day ${clock.day}. ${base}` : base;
}

/**
 * Schedule moves due at a phase: every NPC whose `schedule[phase]` names a
 * DIFFERENT location than where it stands (skips the dead and anyone in the
 * active encounter — nobody walks out of a fight because it's evening).
 *
 * @param {Map<string,object>} entities
 * @param {string} phase
 * @returns {Array<{op:'move', id:string, to:string}>}
 */
export function scheduleMoves(entities, phase) {
  const enc = (entities.get('encounter') || {}).encounter || {};
  const fighting = new Set(enc.active ? [...(enc.allies || []), ...(enc.enemies || [])] : []);
  const ops = [];
  for (const [id, comps] of entities) {
    const dest = comps.schedule && comps.schedule[phase];
    if (!dest) continue;
    if ((comps.identity || {}).kind !== 'npc') continue;
    if ((comps.status || {}).alive === false) continue;
    if (fighting.has(id)) continue;
    if (((comps.place || {}).locationId) === dest) continue;
    if (!entities.has(dest)) continue;
    ops.push({ op: 'move', id, to: dest });
  }
  return ops;
}

/**
 * The ambient line for a location at a phase (authored on
 * flags.ambient as {phase: [lines]} or a flat array). Deterministic pick.
 * @returns {string|null}
 */
export function ambientLine(locEntity, phase, day = 1) {
  const amb = locEntity && locEntity.flags && locEntity.flags.ambient;
  if (!amb) return null;
  const pool = Array.isArray(amb) ? amb : (amb[phase] || null);
  if (!pool || !pool.length) return null;
  return pool[(day + PHASES.indexOf(phase)) % pool.length];
}
