/**
 * server/worldgen.js — P8 "charge with meaning" pass + writer.
 *
 * Stage 2 of world generation. Takes the PURE procgen skeleton from
 * shared/worldgen-skeleton.js (a connected location graph with placeholder names) and
 * uses an LlmClient to fill in identity (name/description), persona, knowledge,
 * and art prompts — turning generic slots into a coherent themed world. Then
 * validates referential integrity and writes a scene JSON in the exact shape the
 * Session seeds from. "Generated once → fixed data."
 *
 * Robustness: charging is per-location and best-effort. If a location's LLM call
 * fails (network/parse/validation), that location falls back to deterministic
 * placeholder names — generation NEVER aborts the whole world over one bad call.
 * The skeleton already guarantees valid structure, so the output always seeds.
 *
 * SECURITY: never logs/echoes secrets. The LlmClient owns the API key; this
 * module only receives an already-constructed client.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { generateSkeleton } from '../shared/worldgen-skeleton.js';
import { validateWorld } from '../shared/worldcheck.js';
import { makeRng } from '../shared/rng.js';

// ---- LLM output schema (one call per location, names everything co-located) ----

const InhabitantSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  personality: z.string().optional(),
  backstory: z.string().optional(),
  voice: z.string().optional(),
  facts: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  artPrompt: z.string().optional(),
}).passthrough();

const LocationChargeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  artPrompt: z.string().optional(),
  inhabitants: z.array(InhabitantSchema).optional(),
}).passthrough();

const QuestChargeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()).optional(),
}).passthrough();

const RegionChargeSchema = z.object({
  regions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    vibe: z.string().optional(),
  }).passthrough()),
}).passthrough();

// ---- Helpers ----

/** Deterministic placeholder name from a generation hint (fallback when no LLM). */
function placeholderName(role, n) {
  switch (role) {
    case 'entrance':   return `The Gateway`;
    case 'lair':       return `The Lair`;
    case 'settlement': return `Hamlet ${n}`;
    case 'wilds':      return `The Wilds ${n}`;
    case 'dungeon':    return `The Depths ${n}`;
    case 'landmark':   return `The Landmark`;
    case 'location':   return `Area ${n}`;
    case 'local':      return `Townsfolk ${n}`;
    case 'hermit':     return `The Recluse`;
    case 'enemy':      return `Marauder ${n}`;
    case 'boss':       return `The Overlord`;
    case 'prize':      return `The Prize`;
    case 'relic':      return `Lost Relic ${n}`;
    case 'item':       return `Curio ${n}`;
    case 'pc':         return `The Wanderer`;
    case 'main-quest': return `The Errand`;
    case 'clear-quest': return `Bounty ${n}`;
    case 'relic-quest': return `The Lost Relic`;
    case 'quest':      return `The Errand`;
    default:           return `Thing ${n}`;
  }
}

/** Placeholder region names by role (fallback when no LLM). */
function placeholderRegionName(role, n) {
  switch (role) {
    case 'settlement': return `The Township ${n}`;
    case 'wilds':      return `The Wilds ${n}`;
    case 'dungeon':    return `The Dark Reach ${n}`;
    case 'landmark':   return `The Old Landmark ${n}`;
    default:           return `Region ${n}`;
  }
}

/** Entities co-located at a location id (npcs/enemies/items/pc), in id order. */
function inhabitantsOf(entities, locId) {
  const out = [];
  for (const [id, comps] of Object.entries(entities)) {
    if (id === locId) continue;
    if (comps.place && comps.place.locationId === locId) out.push(id);
  }
  return out.sort();
}

/** Short role descriptor for the prompt, derived from skeleton hints + components. */
function roleLine(id, comps, hint) {
  const role = (hint && hint.role) || (comps.identity && comps.identity.kind) || 'thing';
  const kind = comps.identity ? comps.identity.kind : 'thing';
  if (role === 'enemy' || comps.flags?.hostile) return `${id} — a hostile enemy (combatant)`;
  if (role === 'prize') return `${id} — the prize item the quest hinges on`;
  if (kind === 'item') return `${id} — an item/object present here`;
  if (kind === 'pc') return `${id} — the player character (the protagonist)`;
  if (kind === 'npc') return `${id} — a friendly/neutral character to talk to`;
  return `${id} — ${role}`;
}

// ---- Charge the regions (one call names them all — cheap, and coherent) ----

/**
 * Name every region in one LLM call. Mutates meta.regions in place ({name, vibe}).
 * Returns true on LLM success. Fallback: deterministic role-based names.
 */
async function chargeRegions(meta, theme, llm, sessionId) {
  const regions = meta.regions || [];
  if (!regions.length) return false;

  const chain = regions.map((r, i) =>
    `${r.id} (role: ${r.role}, ${r.locationIds.length} locations${i < regions.length - 1 ? ', road leads on to ' + regions[i + 1].id : ' — the world\'s far end'})`
  ).join('\n  ');

  const system = [
    `You are a world-builder for a tabletop RPG. Theme: ${theme || 'a grounded low-fantasy adventure'}.`,
    `Name the REGIONS of a world laid out along a road from safe to deadly. Settlements are`,
    `inhabited, wilds are untamed country, dungeons are hostile places, landmarks are strange`,
    `single sights. The LAST region is where the campaign's villain rules. Names must feel like`,
    `one world: shared language, shared history. Reuse the EXACT ids given.`,
  ].join('\n');
  const user = [
    `Regions, in road order:\n  ${chain}`,
    ``,
    `Return JSON ONLY: {"regions":[{"id":"<exact id>","name":"...","vibe":"<one atmospheric sentence>"}]}`,
  ].join('\n');

  try {
    const { parsed } = await llm.structured(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      RegionChargeSchema,
      { user: sessionId, role: 'worldgen' }
    );
    const byId = new Map((parsed.regions || []).map(r => [r.id, r]));
    for (const region of regions) {
      const got = byId.get(region.id);
      if (got && got.name) { region.name = got.name; region.vibe = got.vibe || ''; }
    }
  } catch {
    // fall through to placeholder fill below
  }
  let ok = true;
  regions.forEach((region, i) => {
    if (!region.name) { region.name = placeholderRegionName(region.role, i + 1); ok = false; }
  });
  return ok;
}

// ---- Charge one location ----

/**
 * Charge a single location and everything in it. Mutates `entities` in place.
 * Returns true on LLM success, false if it fell back to placeholders.
 */
async function chargeLocation(entities, meta, locId, theme, llm, sessionId) {
  const loc = entities[locId];
  const hints = meta.hints || {};
  const locHint = hints[locId] || {};
  const inhabIds = inhabitantsOf(entities, locId);

  // Neighbor context: an already-charged neighbor contributes its real NAME, so
  // names knit together as the pass sweeps the map region by region.
  const neighbors = (loc.place?.connections || [])
    .map(c => {
      const t = entities[c.targetId];
      const named = t?.identity?.name && !/^Location \d+$/.test(t.identity.name);
      return named ? `"${t.identity.name}"` : `${c.targetId} (${(hints[c.targetId] || {}).role || 'area'})`;
    })
    .join(', ');

  // Region context (v2): the region pass already named the surrounding country.
  const region = (meta.regions || []).find(r => r.id === locHint.region);
  const siblings = region
    ? region.locationIds
        .filter(id => id !== locId)
        .map(id => entities[id]?.identity?.name)
        .filter(n => n && !/^Location \d+$/.test(n))
    : [];
  const regionLine = region
    ? `It lies in the region "${region.name}" (${region.role})${region.vibe ? ` — ${region.vibe}` : ''}. `
      + `The location needs its OWN distinct name — never reuse the region name`
      + (siblings.length ? ` or these sibling locations' names: ${siblings.map(n => `"${n}"`).join(', ')}` : '')
      + `.`
    : '';

  const inhabLines = inhabIds.map(id => '  - ' + roleLine(id, entities[id], hints[id])).join('\n');

  const system = [
    `You are a world-builder for a tabletop RPG. Theme: ${theme || 'a grounded low-fantasy adventure'}.`,
    `Invent vivid, concrete, internally-consistent names and one-to-three-sentence descriptions.`,
    `This is ONE location of a connected world. Its role: ${locHint.role || 'location'}.`,
    regionLine,
    neighbors ? `It connects to: ${neighbors}. Keep geography plausible.` : ``,
    `Give friendly characters a distinct personality, a short backstory, a voice cue, and 1-3`,
    `"facts" (public knowledge) plus 0-2 "secrets". Enemies need only a name + menacing description`,
    `+ short personality. Items need a name + description. The player character needs a name + a`,
    `one-line description. Every CHARACTER (friend or foe) also gets an "artPrompt" — a one-line`,
    `portrait prompt (face/garb/mood). Reuse the EXACT ids given; do not invent new ids.`,
  ].filter(Boolean).join('\n');

  const user = [
    `Name and describe this location and everything in it. Return JSON ONLY:`,
    `{"name": "...", "description": "...", "artPrompt": "<image prompt>",`,
    ` "inhabitants": [{"id": "<exact id>", "name": "...", "description": "...",`,
    `   "personality": "...", "backstory": "...", "voice": "...",`,
    `   "facts": ["..."], "secrets": ["..."]}]}`,
    ``,
    `Location id: ${locId} (role: ${locHint.role || 'location'})`,
    inhabIds.length ? `Inhabitants/objects here (use these exact ids):\n${inhabLines}` : `Nothing else is here.`,
  ].join('\n');

  try {
    const { parsed } = await llm.structured(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      LocationChargeSchema,
      { user: sessionId, role: 'worldgen' }
    );
    applyLocationCharge(entities, locId, parsed);
    return true;
  } catch (e) {
    fallbackLocation(entities, meta, locId);
    return false;
  }
}

/** Apply a validated location charge result onto the entities. */
function applyLocationCharge(entities, locId, parsed) {
  const loc = entities[locId];
  if (loc.identity) {
    loc.identity.name = parsed.name || loc.identity.name;
    if (parsed.description) loc.identity.description = parsed.description;
  }
  if (loc.art && parsed.artPrompt) loc.art.prompt = parsed.artPrompt;

  const byId = new Map((parsed.inhabitants || []).map(o => [o.id, o]));
  for (const id of inhabitantsOf(entities, locId)) {
    const o = byId.get(id);
    if (!o) continue;
    const e = entities[id];
    if (e.identity) {
      if (o.name) e.identity.name = o.name;
      if (o.description) e.identity.description = o.description;
    }
    if (e.persona) {
      if (o.personality) e.persona.personality = o.personality;
      if (o.backstory && 'backstory' in e.persona) e.persona.backstory = o.backstory;
      if (o.voice && 'voice' in e.persona) e.persona.voice = o.voice;
    }
    if (e.knowledge) {
      if (Array.isArray(o.facts)) e.knowledge.facts = o.facts;
      if (Array.isArray(o.secrets)) e.knowledge.secrets = o.secrets;
    }
    // P5: character portraits — the LLM's portrait prompt becomes art-as-data.
    if (o.artPrompt && (e.identity || {}).kind !== 'item') {
      e.art = { prompt: o.artPrompt, image: null };
    }
  }
}

/** Deterministic placeholder fill for a location that failed to charge. */
function fallbackLocation(entities, meta, locId) {
  const hints = meta.hints || {};
  const loc = entities[locId];
  if (loc.identity && /^Location \d+$/.test(loc.identity.name || '')) {
    const n = parseInt((locId.match(/(\d+)/) || [])[1] || '0', 10);
    loc.identity.name = placeholderName((hints[locId] || {}).role || 'location', n);
  }
  for (const id of inhabitantsOf(entities, locId)) {
    const e = entities[id];
    const n = parseInt((id.match(/(\d+)/) || [])[1] || '0', 10);
    if (e.identity) e.identity.name = placeholderName((hints[id] || {}).role || e.identity.kind, n);
  }
}

// ---- Charge the quests (v2: one main + a side quest per pack/relic) ----

/** Quest-specific brief for the designer prompt, derived from the skeleton hint role. */
function questBrief(entities, meta, qId) {
  const hints = meta.hints || {};
  const role = (hints[qId] || {}).role || 'quest';
  const region = (meta.regions || []).find(r => r.id === (hints[qId] || {}).region);
  const regionName = region ? `"${region.name}" (${region.role})` : 'the region';

  if (role === 'main-quest') {
    const entrance = entities[meta.locationIds?.[0]];
    const lair = entities[meta.lairId];
    const boss = entities[meta.bossId];
    const prize = entities[meta.prizeId];
    return {
      steps: 3,
      brief: `This is the MAIN quest. Start: ${entrance?.identity?.name || 'the entrance'}. `
        + `Climax: ${lair?.identity?.name || 'the lair'}, ruled by ${boss?.identity?.name || 'the villain'}. `
        + `The prize is ${prize?.identity?.name || 'the prize'}. Exactly 3 steps: `
        + `(1) reach the climax location, (2) defeat its master, (3) seize the prize.`,
    };
  }
  if (role === 'relic-quest') {
    const trigger = ((entities[qId] || {}).quest || {}).triggers || [];
    const itemId = (trigger[1] || {}).id;
    const item = entities[itemId];
    return {
      steps: 2,
      brief: `This is a SIDE quest to recover ${item?.identity?.name || 'a lost relic'} from ${regionName}. `
        + `Exactly 2 steps: (1) find where it is kept, (2) recover it.`,
    };
  }
  // clear-quest (a bounty on an enemy pack)
  const packIds = (((entities[qId] || {}).quest || {}).triggers || [])
    .filter(t => t.type === 'allDead').flatMap(t => t.ids || []);
  const packNames = packIds.map(id => entities[id]?.identity?.name).filter(Boolean).join(', ');
  return {
    steps: 2,
    brief: `This is a SIDE quest: a bounty on the threat haunting ${regionName}`
      + `${packNames ? ` (${packNames})` : ''}. Exactly 2 steps: (1) track the threat, (2) destroy it.`,
  };
}

async function chargeQuest(entities, meta, qId, theme, llm, sessionId) {
  const q = entities[qId];
  if (!q || !q.quest) return false;

  const { steps, brief } = questBrief(entities, meta, qId);
  const system = `You are a quest designer. Theme: ${theme || 'a grounded low-fantasy adventure'}. `
    + `Write a short quest that fits this world. ${brief} `
    + `The quest name must be a DEED (a task, a promise, a debt) — not a place name.`;
  const user = `Return JSON ONLY: {"name":"...", "description":"<1-2 sentences>", `
    + `"steps":[${Array.from({ length: steps }, (_, i) => `"<step ${i + 1}>"`).join(',')}]}`;

  try {
    const { parsed } = await llm.structured(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      QuestChargeSchema,
      { user: sessionId, role: 'worldgen' }
    );
    if (q.identity) {
      q.identity.name = parsed.name || q.identity.name;
      if (parsed.description) q.identity.description = parsed.description;
    }
    if (Array.isArray(parsed.steps) && parsed.steps.length) {
      // Preserve count; only replace strings we were given.
      q.quest.steps = q.quest.steps.map((s, i) => parsed.steps[i] || s);
    }
    return true;
  } catch (e) {
    const n = parseInt((qId.match(/(\d+)/) || [])[1] || '0', 10);
    if (q.identity && /Quest|Bounty|Relic/.test(q.identity.name || '')) {
      q.identity.name = placeholderName((meta.hints[qId] || {}).role || 'quest', n);
    }
    return false;
  }
}

// ---- Deterministic post-pass: no two locations share a name -----------------
// In-region charges run concurrently, so two siblings can race to the same name.
// Rename later duplicates with a spatial qualifier instead of another LLM round.

const DEDUPE_PREFIXES = ['Inner', 'Outer', 'Upper', 'Lower', 'Far', 'Old'];

function dedupeLocationNames(entities, meta) {
  const seen = new Map();
  for (const locId of meta.locationIds || []) {
    const loc = entities[locId];
    const name = loc?.identity?.name;
    if (!name) continue;
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    if (n > 0) {
      const prefix = DEDUPE_PREFIXES[(n - 1) % DEDUPE_PREFIXES.length];
      loc.identity.name = name.startsWith('The ')
        ? `The ${prefix} ${name.slice(4)}`
        : `${prefix} ${name}`;
    }
  }
}

// ---- Deterministic post-pass: rewrite connection labels from named targets ----

function relabelConnections(entities) {
  for (const comps of Object.values(entities)) {
    if (!comps.place || !Array.isArray(comps.place.connections)) continue;
    for (const conn of comps.place.connections) {
      const target = entities[conn.targetId];
      const name = target?.identity?.name;
      if (name) conn.label = `To ${name}`;
    }
  }
}

// ---- Public API ----

/**
 * Charge a skeleton with meaning via the LLM. Mutates and returns the skeleton's
 * entities. Always returns valid, seedable entities (failed calls fall back to
 * deterministic placeholders).
 *
 * @param {{entities:object, meta:object}} skeleton  — from generateSkeleton()
 * @param {object} opts
 *   @param {object} opts.llm        — an LlmClient (DeepSeek/Mock)
 *   @param {string} [opts.theme]    — flavor seed for the world
 *   @param {string} [opts.sessionId]
 *   @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{entities:object, charged:number, failed:number}>}
 */
export async function chargeWorld(skeleton, { llm, theme, sessionId = 'worldgen', log = () => {} } = {}) {
  const { entities, meta } = skeleton;
  let charged = 0, failed = 0;

  // v2 pass 0: name the regions (one call, all regions — anchors coherence).
  if ((meta.regions || []).length) {
    const rOk = await chargeRegions(meta, theme, llm, sessionId);
    log(rOk
      ? `charged regions → ${meta.regions.map(r => `"${r.name}"`).join(', ')}`
      : `fallback region names (LLM unavailable)`);
  }

  // Pass 1: locations, region by region (road order) with a small concurrency
  // pool inside each region — the region name carries the coherence, so
  // in-region calls can run in parallel without the world falling apart.
  const POOL = 4;
  const regionBatches = (meta.regions || []).length
    ? meta.regions.map(r => r.locationIds)
    : [meta.locationIds || Object.keys(entities)];
  for (const batch of regionBatches) {
    const queue = batch.filter(id => entities[id]);
    for (let i = 0; i < queue.length; i += POOL) {
      const slice = queue.slice(i, i + POOL);
      const results = await Promise.all(
        slice.map(locId => chargeLocation(entities, meta, locId, theme, llm, sessionId)),
      );
      results.forEach((ok, j) => {
        const locId = slice[j];
        if (ok) { charged++; log(`charged ${locId} → "${entities[locId].identity?.name}"`); }
        else    { failed++;  log(`fallback ${locId} (LLM unavailable)`); }
      });
    }
  }

  // Pass 2: quests (main + sides), after locations so briefs cite real names.
  for (const qId of (meta.questIds || [meta.questId]).filter(Boolean)) {
    const qOk = await chargeQuest(entities, meta, qId, theme, llm, sessionId);
    if (qOk) log(`charged ${qId} → "${entities[qId]?.identity?.name}"`);
  }

  dedupeLocationNames(entities, meta);
  relabelConnections(entities);
  return { entities, charged, failed };
}

/**
 * Full generate → charge → validate pipeline (no write). Throws if the charged
 * world fails referential-integrity validation (should never happen given a valid
 * skeleton; this is a safety net).
 *
 * @param {object} opts  — {size, locations, seed, theme, llm, sessionId, log}
 * @returns {Promise<{entities:object, meta:object, charged:number, failed:number}>}
 */
export async function generateWorld(opts = {}) {
  const { size = 'small', locations, regions, seed = 42, theme, llm, sessionId, log = () => {} } = opts;
  const rng = makeRng(seed);
  const skeleton = generateSkeleton({ size, locations, regions }, rng);
  skeleton.meta.seed = seed;
  log(`skeleton: ${Object.keys(skeleton.entities).length} entities, `
    + `${skeleton.meta.locationIds?.length} locations, ${skeleton.meta.regions?.length} regions, `
    + `${skeleton.meta.packs?.length} enemy packs, ${skeleton.meta.questIds?.length} quests`);

  const { entities, charged, failed } = await chargeWorld(skeleton, { llm, theme, sessionId, log });

  const check = validateWorld(entities);
  if (!check.ok) {
    throw new Error('Generated world failed validation:\n  - ' + check.errors.join('\n  - '));
  }
  return { entities, meta: skeleton.meta, charged, failed };
}

/**
 * Write a world entity-map to a scene JSON file (creates parent dirs).
 * @param {object} entities
 * @param {string} outPath
 */
export function writeWorld(entities, outPath) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(entities, null, 2), 'utf-8');
  return outPath;
}
