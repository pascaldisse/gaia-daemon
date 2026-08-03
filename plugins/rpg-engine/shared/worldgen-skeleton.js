/**
 * shared/worldgen-skeleton.js — PURE deterministic world skeleton generator (Module A).
 *
 * v2: REGIONS. A world is no longer a single string of rooms with one lair — it is
 * a set of themed regions (settlement / wilds / dungeon / landmark) chained by
 * roads, each internally connected, with enemy PACKS distributed across the map,
 * one BOSS lair at the deepest dungeon, and a quest per pack/relic beside the
 * main quest. Identity names and descriptions are PLACEHOLDERS — the LLM charge
 * pass fills them (region names first, then locations with region context).
 *
 * Structure guarantees (what procgen owns):
 *   - the whole graph is connected and bidirectional
 *   - the entrance (loc-1) is in the first settlement region
 *   - the boss lair is the LAST location of the LAST region (max road distance)
 *   - every quest trigger references a real entity id
 *
 * PURE: no server/client imports, no fs, no Date, no Math.random.
 * Deterministic: same config + same-seeded rng ⇒ JSON.stringify-identical.
 *
 * @module shared/worldgen
 */

// ---- internal helpers ----------------------------------------------------

/** Accent palette for NPC agent chips — deterministic by index. */
const ACCENT_PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
  '#9A6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
  '#000075', '#a9a9a9',
];

/** Damage dice options for enemies. */
const DAMAGE_DICE = ['1d4', '1d6', '1d8'];

/** Middle-region role rotation (region 0 is always a settlement, the last always a dungeon). */
const ROLE_CYCLE = ['wilds', 'dungeon', 'settlement', 'wilds', 'landmark'];

/** How many friendly NPCs a region seats, by role. */
const NPCS_PER_REGION = { settlement: 3, landmark: 1, wilds: 1, dungeon: 0 };

function hasConnection(locEntity, targetId) {
  return locEntity.place.connections.some(c => c.targetId === targetId);
}

/** Add a bidirectional edge between two location entities. */
function addBidirectionalEdge(entities, idA, idB) {
  if (idA === idB) return;
  if (!hasConnection(entities[idA], idB)) {
    entities[idA].place.connections.push({ targetId: idB, label: `To ${idB}` });
  }
  if (!hasConnection(entities[idB], idA)) {
    entities[idB].place.connections.push({ targetId: idA, label: `To ${idA}` });
  }
}

/**
 * Resolve generation scale from config + size preset.
 * @returns {{size:string, locCount:number, regionCount:number}}
 */
function resolveCounts(config) {
  let size = config.size;
  if (!['small', 'medium', 'large', 'epic'].includes(size)) size = 'small';

  const presets = {
    small:  { locations: 4,  regions: 1 },
    medium: { locations: 10, regions: 3 },
    large:  { locations: 24, regions: 6 },
    epic:   { locations: 36, regions: 9 },
  };
  const preset = presets[size];

  const locCount =
    typeof config.locations === 'number' && config.locations > 0 && Number.isInteger(config.locations)
      ? config.locations
      : preset.locations;

  let regionCount =
    typeof config.regions === 'number' && config.regions > 0 && Number.isInteger(config.regions)
      ? config.regions
      : (typeof config.locations === 'number'
          ? Math.max(1, Math.round(locCount / 4))
          : preset.regions);
  regionCount = Math.max(1, Math.min(regionCount, locCount));

  return { size, locCount, regionCount };
}

/** Partition locCount into regionCount contiguous runs (larger runs first). */
function partition(locCount, regionCount) {
  const base = Math.floor(locCount / regionCount);
  const extra = locCount % regionCount;
  const runs = [];
  let cursor = 0;
  for (let r = 0; r < regionCount; r++) {
    const size = base + (r < extra ? 1 : 0);
    runs.push({ start: cursor, size });
    cursor += size;
  }
  return runs;
}

/** Role of region r out of k. First = settlement, last = dungeon (boss), middle cycle. */
function regionRole(r, k) {
  if (r === 0 && k === 1) return 'dungeon';       // a one-region world IS the dungeon crawl
  if (r === 0) return 'settlement';
  if (r === k - 1) return 'dungeon';
  return ROLE_CYCLE[(r - 1) % ROLE_CYCLE.length];
}

// ---- exported generator --------------------------------------------------

/**
 * Generate the structural skeleton of a world.
 *
 * @param {object} config
 *   @param {'small'|'medium'|'large'|'epic'} [config.size='small']
 *   @param {number} [config.locations]   explicit location count (overrides size preset)
 *   @param {number} [config.regions]     explicit region count
 * @param {{next:()=>number,int:(a,b)=>number,d:(s)=>number}} rng  — from makeRng(seed)
 * @returns {{ entities: Record<string, object>, meta: object }}
 */
export function generateSkeleton(config = {}, rng) {
  const { size, locCount, regionCount } = resolveCounts(config);

  const entities = {};
  const meta = {
    size,
    pcId: 'pc-hero',
    questId: 'quest-1',
    questIds: [],
    lairId: null,
    bossId: null,
    prizeId: null,
    locationIds: [],
    regions: [],
    packs: [],
    hints: {},
  };

  // ---- 1. Locations + regions ---------------------------------------------

  for (let i = 1; i <= locCount; i++) {
    const id = `loc-${i}`;
    meta.locationIds.push(id);
    entities[id] = {
      identity: { name: `Location ${i}`, kind: 'location', description: '' },
      place: { connections: [] },
      status: { alive: true, conditions: [] },
      art: { prompt: '', image: null },
    };
    meta.hints[id] = { kind: 'location', role: 'location', region: null };
  }

  const runs = partition(locCount, regionCount);
  for (let r = 0; r < regionCount; r++) {
    const role = regionRole(r, regionCount);
    const regionId = `region-${r + 1}`;
    const locIds = meta.locationIds.slice(runs[r].start, runs[r].start + runs[r].size);
    meta.regions.push({ id: regionId, role, name: '', locationIds: locIds });
    for (const id of locIds) {
      meta.hints[id].region = regionId;
      meta.hints[id].role = role;
    }
  }
  // The entrance is the first location of the first region; the lair the last of the last.
  meta.hints['loc-1'].role = 'entrance';
  const lastRegion = meta.regions[meta.regions.length - 1];
  const lairId = lastRegion.locationIds[lastRegion.locationIds.length - 1];
  meta.lairId = lairId;
  meta.hints[lairId].role = 'lair';

  // ---- 2. Graph: intra-region paths + chords, inter-region roads -----------

  for (const region of meta.regions) {
    const ids = region.locationIds;
    // Spanning path inside the region.
    for (let i = 0; i < ids.length - 1; i++) addBidirectionalEdge(entities, ids[i], ids[i + 1]);
    // Chords (~size/3) for non-linearity.
    const chords = Math.floor(ids.length / 3);
    const candidates = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 2; j < ids.length; j++) candidates.push([ids[i], ids[j]]);
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (let e = 0; e < Math.min(chords, candidates.length); e++) {
      addBidirectionalEdge(entities, candidates[e][0], candidates[e][1]);
    }
  }

  // Roads: chain region r → r+1 (a random member of r meets the first location of r+1),
  // guaranteeing global connectivity while keeping the lair at the far end of the chain.
  for (let r = 0; r < meta.regions.length - 1; r++) {
    const from = meta.regions[r].locationIds;
    const to = meta.regions[r + 1].locationIds;
    addBidirectionalEdge(entities, from[rng.int(0, from.length - 1)], to[0]);
  }
  // A few cross-region shortcuts (skip the last region: the lair stays deep).
  const shortcuts = Math.floor((regionCount - 1) / 3);
  for (let s = 0; s < shortcuts; s++) {
    const a = rng.int(0, regionCount - 2);
    let b = rng.int(0, regionCount - 2);
    if (a === b) b = (b + 1) % (regionCount - 1);
    const fromIds = meta.regions[a].locationIds;
    const toIds = meta.regions[b].locationIds;
    addBidirectionalEdge(
      entities,
      fromIds[rng.int(0, fromIds.length - 1)],
      toIds[rng.int(0, toIds.length - 1)],
    );
  }

  // ---- 3. PC ---------------------------------------------------------------

  const pcHp = rng.int(18, 22);
  entities['pc-hero'] = {
    identity: { name: 'Hero', kind: 'pc', description: '' },
    stats: {
      str: rng.int(12, 16), dex: rng.int(12, 16), con: rng.int(10, 14),
      int: rng.int(8, 14), wis: rng.int(8, 14), cha: rng.int(8, 14),
      hp: pcHp, maxHp: pcHp, ac: rng.int(12, 14), proficiency: 2, level: 1, xp: 0,
    },
    status: { alive: true, conditions: [] },
    place: { locationId: 'loc-1', connections: [] },
    inventory: { items: [{ id: 'item-startgear', name: "Traveler's Pack", qty: 1 }] },
    flags: {},
  };
  meta.hints['pc-hero'] = { kind: 'pc', role: 'pc' };

  // ---- 4. Friendly NPCs (settlements seat most; wilds/landmarks get a hermit) ----

  let npcSeq = 0;
  for (const region of meta.regions) {
    const seats = NPCS_PER_REGION[region.role] ?? 0;
    for (let s = 0; s < seats; s++) {
      npcSeq += 1;
      const id = `npc-${npcSeq}`;
      const loc = region.locationIds[rng.int(0, region.locationIds.length - 1)];
      entities[id] = {
        identity: { name: `Townsperson ${npcSeq}`, kind: 'npc', description: '' },
        persona: { personality: '', backstory: '', voice: '' },
        knowledge: { facts: [], secrets: [] },
        agent: { enabled: true, accent: ACCENT_PALETTE[(npcSeq - 1) % ACCENT_PALETTE.length] },
        status: { alive: true, conditions: [] },
        place: { locationId: loc, connections: [] },
        inventory: { items: [] },
        flags: { trust_player: 0 },
      };
      meta.hints[id] = {
        kind: 'npc',
        role: region.role === 'settlement' ? 'local' : 'hermit',
        region: region.id,
      };
    }
  }

  // ---- 5. Enemy packs (distributed) + the boss ------------------------------

  let enemySeq = 0;
  const mkEnemy = (locId, region, boss = false) => {
    enemySeq += 1;
    const id = `enemy-${enemySeq}`;
    const eHp = boss ? rng.int(20, 26) : rng.int(7, 13);
    entities[id] = {
      identity: { name: boss ? 'The Overlord' : `Foe ${enemySeq}`, kind: 'npc', description: '' },
      persona: { personality: '' },
      stats: {
        str: rng.int(boss ? 12 : 8, boss ? 17 : 14), dex: rng.int(8, 14), con: rng.int(boss ? 12 : 8, 14),
        int: rng.int(8, 12), wis: rng.int(8, 12), cha: rng.int(8, 12),
        hp: eHp, maxHp: eHp, ac: boss ? rng.int(14, 15) : rng.int(11, 13),
        xp: boss ? 150 : rng.int(25, 50),
      },
      status: { alive: true, conditions: [] },
      place: { locationId: locId, connections: [] },
      flags: { hostile: true, damage: boss ? '1d8' : DAMAGE_DICE[rng.int(0, 2)] },
    };
    meta.hints[id] = { kind: 'npc', role: boss ? 'boss' : 'enemy', region: region.id };
    return id;
  };

  for (let r = 0; r < meta.regions.length; r++) {
    const region = meta.regions[r];
    const isBossRegion = r === meta.regions.length - 1;
    if (region.role === 'settlement' || region.role === 'landmark') continue;

    const packIds = [];
    const packLocs = new Set();
    if (isBossRegion) {
      // The boss + guards at the lair; a straggler deeper in the region if it has room.
      meta.bossId = mkEnemy(lairId, region, true);
      packIds.push(meta.bossId);
      packLocs.add(lairId);
      packIds.push(mkEnemy(lairId, region));
      if (region.locationIds.length > 1) {
        const outpost = region.locationIds[rng.int(0, region.locationIds.length - 2)];
        packIds.push(mkEnemy(outpost, region));
        packLocs.add(outpost);
      }
    } else if (region.role === 'dungeon') {
      for (let i = 0; i < 3; i++) {
        const loc = region.locationIds[rng.int(0, region.locationIds.length - 1)];
        packIds.push(mkEnemy(loc, region));
        packLocs.add(loc);
      }
    } else { // wilds
      const den = region.locationIds[rng.int(0, region.locationIds.length - 1)];
      const n = 1 + rng.int(0, 1);
      for (let i = 0; i < n; i++) packIds.push(mkEnemy(den, region));
      packLocs.add(den);
    }
    meta.packs.push({ regionId: region.id, role: region.role, boss: isBossRegion, ids: packIds, locIds: [...packLocs] });
  }

  // ---- 6. Items: the prize at the lair, a relic per dungeon, scatter elsewhere ----

  let itemSeq = 0;
  const mkItem = (locId, role, region) => {
    itemSeq += 1;
    const id = `item-${itemSeq}`;
    entities[id] = {
      identity: { name: `Object ${itemSeq}`, kind: 'item', description: '' },
      status: { alive: true, conditions: [] },
      place: { locationId: locId, connections: [] },
    };
    meta.hints[id] = { kind: 'item', role, region: region ? region.id : null };
    return id;
  };

  meta.prizeId = mkItem(lairId, 'prize', lastRegion);
  const relics = []; // per non-boss dungeon region → side-quest fetch target
  for (let r = 0; r < meta.regions.length - 1; r++) {
    const region = meta.regions[r];
    if (region.role === 'dungeon') {
      const loc = region.locationIds[rng.int(0, region.locationIds.length - 1)];
      relics.push({ itemId: mkItem(loc, 'relic', region), locId: loc, regionId: region.id });
    } else {
      // One mundane item somewhere in every other region keeps looting alive.
      const loc = region.locationIds[rng.int(0, region.locationIds.length - 1)];
      mkItem(loc, 'item', region);
    }
  }

  // ---- 7. Quests: one main + one per pack/relic ------------------------------

  const bossPack = meta.packs.find(p => p.boss) || { ids: [] };
  entities['quest-1'] = {
    identity: { name: 'The Main Quest', kind: 'quest', description: '' },
    quest: {
      phase: 'active',
      currentStep: 0,
      steps: ['Reach the lair', 'Defeat its master', 'Seize the prize'],
      triggers: [
        { type: 'atLocation', id: lairId },
        { type: 'allDead', ids: [...bossPack.ids] },
        { type: 'hasItem', id: meta.prizeId },
      ],
      rewards: { xp: 250, items: [] },
    },
  };
  meta.hints['quest-1'] = { kind: 'quest', role: 'main-quest' };
  meta.questIds.push('quest-1');

  let questSeq = 1;
  for (const pack of meta.packs) {
    if (pack.boss) continue;
    questSeq += 1;
    const qid = `quest-${questSeq}`;
    entities[qid] = {
      identity: { name: `Bounty ${questSeq}`, kind: 'quest', description: '' },
      quest: {
        phase: 'active',
        currentStep: 0,
        steps: ['Track the threat', 'Destroy it'],
        triggers: [
          { type: 'atLocation', id: pack.locIds[0] },
          { type: 'allDead', ids: [...pack.ids] },
        ],
        rewards: { xp: 80, items: [] },
      },
    };
    meta.hints[qid] = { kind: 'quest', role: 'clear-quest', region: pack.regionId };
    meta.questIds.push(qid);
  }
  for (const relic of relics) {
    questSeq += 1;
    const qid = `quest-${questSeq}`;
    entities[qid] = {
      identity: { name: `Relic ${questSeq}`, kind: 'quest', description: '' },
      quest: {
        phase: 'active',
        currentStep: 0,
        steps: ['Find where it is kept', 'Recover it'],
        triggers: [
          { type: 'atLocation', id: relic.locId },
          { type: 'hasItem', id: relic.itemId },
        ],
        rewards: { xp: 60, items: [] },
      },
    };
    meta.hints[qid] = { kind: 'quest', role: 'relic-quest', region: relic.regionId };
    meta.questIds.push(qid);
  }

  // ---- 8. world-state singleton ---------------------------------------------

  // artStyle is the world's visual anchor — appended to EVERY art prompt by the
  // art engine so all generations read as one art-directed game (P5).
  entities['world-state'] = { flags: { artStyle: 'dark fantasy oil painting, muted gloomy palette, cinematic lighting' } };

  return { entities, meta };
}
