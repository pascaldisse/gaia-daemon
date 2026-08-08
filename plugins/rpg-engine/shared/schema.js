/**
 * shared/schema.js — declarative SCHEMA object.
 * The single source of truth for component vocabulary, field docs, ranges, and enums.
 * Consumed by: server validation, client inspector, AI-DM vocabulary, HTTP /schema.
 *
 * EXTENSION SEAM: rulesets call registerComponents(extra) to add their components
 * (stats shape, skills, conditions, spells…). The SCHEMA is deep-merged.
 *
 * PURE — no imports from server/ or client/.
 */

/** @type {Record<string, {doc:string, default?:object, fields?:Record<string,{doc:string,range?:[number,number],enum?:string[]}>}>} */
export const SCHEMA = {
  identity: {
    doc: 'Who or what this entity is — name, kind, and a short player-facing description.',
    default: { name: 'Unnamed', kind: 'npc', description: '' },
    fields: {
      name: { doc: 'Display name.' },
      kind: { doc: 'Entity kind.', enum: ['location', 'npc', 'item', 'quest', 'faction', 'pc', 'world-state', 'presence'] },
      description: { doc: 'Short visible description.' },
    },
  },
  place: {
    doc: 'Where an entity is — its current location and connections.',
    default: { locationId: null, connections: [] },
    fields: {
      locationId: { doc: 'ID of the location entity this entity is at (or null if it IS a location).' },
      connections: { doc: 'Array of {targetId, label, distance?} — exits/links from a location.' },
    },
  },
  stats: {
    doc: 'Numerical attributes. Shape is extended by the loaded ruleset. Includes 5e abilities, hp, and proficiency.',
    default: { hp: 10, maxHp: 10, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiency: 2, level: 1 },
    fields: {
      hp: { doc: 'Current hit points.', range: [0, 9999] },
      maxHp: { doc: 'Maximum hit points.', range: [1, 9999] },
      str: { doc: 'Strength score (5e: 1-30).', range: [1, 30] },
      dex: { doc: 'Dexterity score (5e: 1-30).', range: [1, 30] },
      con: { doc: 'Constitution score (5e: 1-30).', range: [1, 30] },
      int: { doc: 'Intelligence score (5e: 1-30).', range: [1, 30] },
      wis: { doc: 'Wisdom score (5e: 1-30).', range: [1, 30] },
      cha: { doc: 'Charisma score (5e: 1-30).', range: [1, 30] },
      proficiency: { doc: 'Proficiency bonus (5e: 2-6).', range: [2, 6] },
      level: { doc: 'Character level.', range: [1, 20] },
      xp: { doc: 'Experience points.', range: [0, 9999999] },
      ac: { doc: 'Armor Class — DC for incoming attacks.', range: [1, 40] },
    },
  },
  inventory: {
    doc: 'Items carried by an entity.',
    default: { items: [] },
    fields: {
      items: { doc: 'Array of {id:string, qty?:number} references.' },
    },
  },
  persona: {
    doc: 'NPC personality, backstory, and voice cues — drives dialogue and behaviour.',
    default: { personality: '', backstory: '' },
    fields: {
      personality: { doc: 'Short personality description (traits, manner, goals).' },
      backstory: { doc: 'Relevant history paragraphs.' },
    },
  },
  relationships: {
    doc: 'Affinity map: other-entity-id → intensity and notes.',
    default: {},
    fields: {
      // open map — no fixed fields
    },
  },
  quest: {
    doc: 'Tracked objective with phases.',
    default: { phase: 'available', steps: [], currentStep: 0, triggers: [], rewards: { xp: 0, items: [] } },
    fields: {
      phase: { doc: 'Current phase.', enum: ['available', 'active', 'completed', 'failed'] },
      steps: { doc: 'Array of step descriptions / objectives.' },
      currentStep: { doc: 'Index into steps (0-based).', range: [0, 999] },
      triggers: { doc: 'Per-step trigger descriptors; triggers[i] gates advancing FROM step i. null = manual/never.' },
      rewards: { doc: 'Granted when the quest completes: { xp:number, items:[{id,name}] }.' },
    },
  },
  status: {
    doc: 'Life and condition flags.',
    default: { alive: true, conditions: [] },
    fields: {
      alive: { doc: 'Is the entity alive? (false = dead/destroyed).' },
      conditions: { doc: 'Active conditions (e.g. prone, poisoned, invisible).' },
    },
  },
  statuses: {
    doc: 'Mechanical status-effect engine (C1). DISTINCT from the narrative `status` {alive,conditions} component. Each entry ticks/bites per the ruleset\'s STATUS_DEFS (shared/statuses.js).',
    default: { list: [] },
    fields: {
      list: {
        doc: 'Array of { kind, magnitude?, remaining, source? }. kind = a status id from the ruleset STATUS_DEFS (bleed/stun/rage/…); magnitude = strength; remaining = turns/ticks left (0 ⇒ expire); source = who applied it.',
      },
    },
  },
  meter: {
    doc: 'Resource meters (C5): overdrive / spell points / cooldowns. Neutral open map, e.g. { overdrive: 0..100 }.',
    default: {},
    fields: {
      overdrive: { doc: 'Overdrive/limit-break charge 0..100. Fills on damage dealt/taken; a finisher Move (requiresOverdrive) consumes it.', range: [0, 100] },
    },
  },
  position: {
    doc: 'Abstract combat zone of a combatant (C4). Absent ⇒ the single implicit zone "field".',
    default: { zoneId: 'field' },
    fields: {
      zoneId: { doc: 'Id of the encounter zone this combatant currently occupies.' },
    },
  },
  flags: {
    doc: 'Arbitrary canon key→value store. Use for world-state gates, story flags, any extensible data.',
    default: {},
    fields: {
      // open object — no fixed fields
    },
  },
  art: {
    doc: 'Art direction for this entity — prompt for generation + optional cached image reference.',
    default: { prompt: '', image: null },
    fields: {
      prompt: { doc: 'Image-generation prompt describing the entity / scene.' },
      image: { doc: 'Cached image URL or data-uri (or null).' },
    },
  },
  tiles: {
    doc: 'Walkable tile map of a LOCATION — semantic tags rendered through a swappable tileset skin. Generated deterministically (worldgen or boot backfill); authored grids win. Presentation + traversal only: combat stays zone-based.',
    default: null,
    fields: {
      w: { doc: 'Grid width in tiles.' },
      h: { doc: 'Grid height in tiles.' },
      rows: { doc: 'Array of h strings of w chars; legend maps each char to a semantic tag.' },
      legend: { doc: 'Char → semantic tag (floor/wall/water/tree/road/…). Tilesets bind to tags.' },
      exits: { doc: 'Array of {x, y, targetId} — stepping here travels to the connected location.' },
      spawns: { doc: 'Entity id → {x, y} — where co-located entities stand on the grid.' },
      style: { doc: 'Generator style used (settlement/wilds/dungeon/landmark/interior).' },
    },
  },
  lifelog: {
    doc: 'Per-character durable memory (P6). The memory engine appends clock-stamped entries off the journal; past the threshold an LLM folds old entries into the ≤80-word living summary. Canon that survives the context window.',
    default: { summary: '', entries: [] },
    fields: {
      summary: { doc: 'The living summary — folded-down past events (≤80 words).' },
      entries: { doc: 'Recent clock-stamped memory lines, e.g. "Day 2, evening: The fight is over…".' },
    },
  },
  clock: {
    doc: 'The world clock (on the world-state singleton): 4-phase days. Ticks on world actions; phase changes move scheduled NPCs and surface ambient lines.',
    default: { day: 1, phase: 'morning', ticks: 0 },
    fields: {
      day: { doc: 'Calendar day, 1-based.' },
      phase: { doc: 'morning | afternoon | evening | night.' },
      ticks: { doc: 'World actions into the current phase.' },
    },
  },
  schedule: {
    doc: 'An NPC\'s daily rounds: phase → location id (e.g. {morning:"loc-inn", night:"loc-home"}). On each phase change the NPC walks there (unless dead or mid-encounter). Omitted phases = stay put.',
    default: {},
    fields: {
      morning: { doc: 'Location id at morning (optional).' },
      afternoon: { doc: 'Location id in the afternoon (optional).' },
      evening: { doc: 'Location id in the evening (optional).' },
      night: { doc: 'Location id at night (optional).' },
    },
  },
  knowledge: {
    doc: 'Private scoped knowledge for an NPC agent — ONLY this enters the NPC\'s context. The DM may add to it.',
    default: { facts: [], secrets: [] },
    fields: {
      facts: { doc: 'Public-ish things this NPC knows.' },
      secrets: { doc: 'Things this NPC knows but guards.' },
    },
  },
  agent: {
    doc: 'Marks an entity as an agent-client (NPC). Extension seam for model/voice/controller overrides.',
    default: { enabled: true, controller: 'ai' },
    fields: {
      enabled: { doc: 'Is this entity an active agent?' },
      controller: { doc: 'Who drives this seat: "ai" (LLM agent) or a clientId (a human puppeting it). The responder dispatch resolves this — see DESIGN-NOTES.md #1. Human control is a future drop-in.' },
      model: { doc: 'Optional LlmClient model override.' },
      systemPrompt: { doc: 'Optional explicit system prompt; else derived from persona.' },
      accent: { doc: 'UI accent color (hex) for this NPC\'s dialogue chip.' },
    },
  },
  encounter: {
    doc: 'Active combat encounter (the floor/turn system). Lives on the singleton entity id "encounter".',
    default: { active: false, round: 0, order: [], turnIndex: 0, mode: 'initiative', enemies: [], allies: [], participants: [], turnOf: null, queue: [] },
    fields: {
      active:    { doc: 'Is a combat encounter in progress?' },
      round:     { doc: 'Current round number (1-based once started).' },
      order:     { doc: 'Initiative order: array of combatant entity ids, highest initiative first.' },
      turnIndex: { doc: 'Index into order whose turn it is.' },
      mode:      { doc: 'Turn mode.', enum: ['initiative', 'free', 'round-robin', 'timeline'] },
      enemies:   { doc: 'Entity ids hostile to the party.' },
      allies:    { doc: 'Entity ids on the party side (incl. the PC).' },
      participants: { doc: 'CTB timeline (C2): array of { id, time, speed, summonTurns? }. time = accumulated action cost; the actor with min time acts next.' },
      turnOf:    { doc: 'CTB timeline (C2): id of the combatant whose turn it is now.' },
      queue:     { doc: 'CTB timeline (C2): projected upcoming actor ids (the visible turn bar).' },
      zones:     { doc: 'Abstract combat zones (C4): array of { id, label, tags? } — e.g. {id:"altar",label:"The Altar",tags:["raised"]}. Absent ⇒ a single implicit "field" zone.' },
      hazards:   { doc: 'Improvised surfaces (C4): array of { zoneId, kind, magnitude, remaining } — statuses on a zone (fire/oil/…) that tick on combatants standing there.' },
    },
  },
  dmControl: {
    doc: 'DMView control state (singleton entity "dm-control"). Drives the propose→approve gate.',
    default: { autopilot: true },
    fields: {
      autopilot: { doc: 'true = LLM beats auto-apply (autopilot); false = paused, DM must approve each proposed beat.' },
    },
  },
  persist: {
    doc: 'Entities with this component survive reset. No fields — presence is the flag.',
    default: {},
    fields: {},
  },
  presence: {
    doc: 'A connected client session occupying a seat. Any seat (dm/npc/player) may be driven by an LLM agent or a human — see DESIGN-NOTES.md #1.',
    default: { seat: 'player', who: 'anonymous', mode: 'play', controller: 'ai' },
    fields: {
      seat: { doc: 'Role.', enum: ['player', 'dm', 'npc', 'spectator'] },
      who: { doc: 'Display name for this seat.' },
      mode: { doc: 'Seat mode.', enum: ['play', 'review', 'auto'] },
      controller: { doc: 'Who drives this seat: "ai" or a clientId. Lets a human take over any agent seat later.' },
    },
  },
};

// ---- Helpers (used by ops validation, client inspector) ----

/**
 * Return the default value for a component, or a fresh empty object.
 * @param {string} name
 * @returns {object}
 */
export function componentDefaults(name) {
  const comp = SCHEMA[name];
  if (comp && comp.default) return JSON.parse(JSON.stringify(comp.default));
  return {};
}

/**
 * Return field metadata for a component field, or null.
 * @param {string} component
 * @param {string} field
 * @returns {{doc:string,range?:[number,number],enum?:string[]}|null}
 */
export function fieldInfo(component, field) {
  const comp = SCHEMA[component];
  if (!comp || !comp.fields) return null;
  return comp.fields[field] || null;
}

/**
 * EXTENSION SEAM: register additional component definitions from a ruleset or campaign.
 * Deep-merges into SCHEMA. Call at startup before any validation.
 *
 * @param {Record<string,object>} extra — { componentName: {doc, default?, fields?} }
 */
export function registerComponents(extra) {
  for (const [name, def] of Object.entries(extra)) {
    if (SCHEMA[name]) {
      // Merge fields, keeping existing overrides
      const existing = SCHEMA[name];
      existing.doc = def.doc || existing.doc;
      if (def.default) existing.default = { ...existing.default, ...def.default };
      if (def.fields) existing.fields = { ...existing.fields, ...def.fields };
    } else {
      SCHEMA[name] = { ...def };
    }
  }
}
