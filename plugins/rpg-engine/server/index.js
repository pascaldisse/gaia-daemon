/**
 * server/index.js — entry point.
 * HTTP server + WebSocket hub. Owns one Session.
 *
 * Based on GAIA's server/index.js architecture.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';
import { SCHEMA } from '../shared/schema.js';
import { validateOpBatch } from '../shared/ops.js';
import { redactForSeat, seatSees } from '../shared/visibility.js';
import { bindPlayerPc } from '../shared/staging.js';
import { createLlmClient } from './llm.js';
import { createTurnEngine } from './turn.js';
import { createCombatEngine } from './combat.js';
import { createQuestEngine } from './quests.js';
import { createMemoryEngine, recall } from './memory.js';
import { createArtEngine } from './art.js';
import { createMusicEngine } from './music.js';
import { createVoiceEngine } from './voice.js';
import { createEncounterEngine } from './encounters.js';
import { createProgression } from './progression.js';
import { loadRuleset } from './ruleset.js';
import { loadAddons, addonWorldOf, readSystemAppends, runServerHooks, createAddonHttp } from './addons.js';
import { expandOps } from '../shared/effects.js';
import { createDmAgent } from './agents/dm-agent.js';
import { createNpcAgent } from './agents/npc-agent.js';
import * as sense from './sense.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const TTRPG_PORT = parseInt(process.env.TTRPG_PORT || '8420', 10);
const TTRPG_SAVE = process.env.TTRPG_SAVE || 'default';

/** MIME types GET /music/<file> knows how to serve (matches createMusicEngine's track glob). */
const MUSIC_MIME = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

// ---- Addons (plugins) ----
// Discovered from addons.json + TTRPG_ADDONS before anything boots: an addon may
// BE the campaign (world/ruleset), extend the DM prompt, and (below, after the
// engines exist) register server hooks + serve a client plugin.
const { addons, configFile: addonsConfigFile } = loadAddons({ rootDir: ROOT_DIR, env: process.env });

// World resolution: explicit TTRPG_WORLD wins; else the first enabled addon that
// ships a world (with its manifest ruleset as the default); else ./world.
let TTRPG_WORLD = process.env.TTRPG_WORLD || null;
let TTRPG_RULESET = process.env.TTRPG_RULESET || null;
if (!TTRPG_WORLD) {
  const aw = addonWorldOf(addons);
  if (aw) {
    TTRPG_WORLD = aw.world;
    TTRPG_RULESET = TTRPG_RULESET || aw.ruleset;
    console.log(`[addons] Campaign from addon "${aw.id}": ${aw.world}${aw.ruleset ? ` (ruleset ${aw.ruleset})` : ''}`);
  }
}
if (!TTRPG_WORLD) TTRPG_WORLD = path.resolve(ROOT_DIR, 'world');

// ---- Runtime game construction ----

const llm = createLlmClient();
// P5: mood-driven music cues. tracksDir/defaultMood are process-wide (not per-campaign),
// so the engine lives at boot alongside llm rather than inside createGame().
const musicEngine = createMusicEngine();
// TTS narration engine (P?: voice route + encounter narration). Provider/key are
// process-wide (env), so — like musicEngine — it lives at boot, not per-campaign.
const voiceEngine = createVoiceEngine();
const progressionEngine = createProgression();
const addonPromptParts = addons.filter(a => a.enabled).map(readSystemAppends).filter(Boolean);
if (addonPromptParts.length) {
  console.log(`[addons] System prompt extended by ${addonPromptParts.length} addon file set(s)`);
}

// Mutable aliases keep the existing HTTP/WS handlers small. SessionManager only
// changes them after a complete replacement game has been constructed.
let game = null;
let session = null;
let artEngine = null;
let dmAgent = null;
let npcAgent = null;
let questEngine = null;
let memoryEngine = null;
let combat = null;
let turnEngine = null;
let rulesetActorTemplates = null;
let addonRoutes = new Map();
let addonHookCtx = null;
let wss = null;

/**
 * P5: does this validated op change "the scene" the music should follow? Either
 * a PC/entity moved to a new location, or the world mood was set directly (the
 * DM's dm-control 'setMood' action merges world-state.flags.mood — see below).
 */
function isSceneChangeOp(op) {
  if (op.op === 'move') return true;
  return op.op === 'merge' && op.component === 'flags' && op.id === 'world-state'
    && op.value && Object.prototype.hasOwnProperty.call(op.value, 'mood');
}

/** The {mood, tags} scene descriptor musicEngine.cueForScene() expects, for a scene-change op. */
function sceneFor(op, targetSession) {
  if (op.op === 'move') {
    const loc = targetSession.entities.get(op.to) || {};
    return { mood: loc.flags && loc.flags.mood, tags: loc.flags };
  }
  return { mood: op.value.mood, tags: (targetSession.entities.get(op.id) || {}).flags };
}

/**
 * Load a campaign's random-encounter table from `<worldDir>/encounters.json`.
 * Tolerates a missing/invalid/non-array file by returning an empty table (no
 * encounters), so a campaign without the file simply never rolls one.
 * @param {string} worldDir
 * @returns {Array<object>} the encounter entries, or [] on any problem
 */
function loadEncounterTable(worldDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(worldDir, 'encounters.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Construct one complete session + engine graph for a campaign/save tuple. */
async function createGame(worldDir, ruleset, slot, { load = true, protagonist = null } = {}) {
  let rulesetPrompt = null;
  let rulesetCombat = null;
  let actorTemplates = null;
  let rulesetDefaultCheck = null;

  if (ruleset) {
    try {
      const rs = await loadRuleset(ruleset, worldDir);
      rulesetPrompt = rs.systemPrompt || null;
      rulesetCombat = rs.combat || null;
      actorTemplates = rs.actorTemplates || null;
      rulesetDefaultCheck = rs.defaultCheck || null;
      console.log(`[ruleset] Loaded "${(rs.meta && rs.meta.name) || ruleset}" (${(rs.meta && rs.meta.dice) || '?'})${rulesetCombat ? ' +combat' : ''}${actorTemplates ? ' +spawn' : ''}`);
    } catch (e) {
      console.error(`[ruleset] Failed to load "${ruleset}": ${e.message} — using built-in 5e defaults.`);
    }
  }
  if (addonPromptParts.length) {
    rulesetPrompt = [rulesetPrompt || '', ...addonPromptParts].filter(Boolean).join('\n\n');
  }

  const nextSession = new Session(worldDir, slot);
  console.log(`[session] Seeding from ${worldDir}`);
  nextSession.seedFromWorld(worldDir);
  if (load) nextSession.load();
  console.log(`[session] Ready — ${nextSession.entities.size} entities, counter ${nextSession.counter}`);

  if (!nextSession.entities.has('dm-control')) {
    nextSession.applyOps([{
      op: 'spawn', id: 'dm-control',
      components: { dmControl: { autopilot: true }, identity: { name: 'DM Control', kind: 'world-state' } },
    }], 'system');
  }
  if (protagonist) customizeProtagonist(nextSession, protagonist, actorTemplates);

  // Per-campaign random encounters: a tick-driven roller over this world's table.
  // The tick advances on player movement (below), so encounters pace with travel.
  const encounterEngine = createEncounterEngine({ table: loadEncounterTable(worldDir) });
  let encounterTick = 0;

  let active = true;
  const scopedBroadcast = (msg, audience = 'all') => {
    if (active) broadcast(msg, audience);
  };
  const scopedApply = (ops, from) => {
    if (!active) return { ok: false, error: 'Game is no longer active', status: 409 };
    const validation = validateOpBatch(ops);
    if (!validation.ok) return { ok: false, error: validation.error, status: 400 };
    let expanded;
    try { expanded = expandOps(nextSession.entities, validation.ops); }
    catch (e) { return { ok: false, error: `Op expansion failed: ${e.message}`, status: 400 }; }
    const result = nextSession.applyOps(expanded, from);
    if (!result.ok) return { ...result, status: 409 };
    if (result.resnapshot) {
      if (game && game.session === nextSession) rebindConnectedPlayers();
      scopedBroadcast(nextSession.snapshot());
    }
    if (result.broadcast?.length) scopedBroadcast({ type: 'ops', ops: result.broadcast });
    // P5: on a scene change (PC moved, or the DM/world set a mood), broadcast the
    // matching music cue verbatim — the client half owns playback (event contract only).
    const sceneOp = [...validation.ops].reverse().find(isSceneChangeOp);
    if (sceneOp) scopedBroadcast(musicEngine.cueForScene(sceneFor(sceneOp, nextSession)));
    // Random encounters: raw move ops (tests / direct POST /op) tick here; real
    // played moves tick via the turn engine's onPlayerMove hook — never both for
    // the same move, because doMove's ops arrive pre-expanded.
    for (const op of validation.ops) {
      if (op.op === 'move') rollEncounterForMove(op.id);
    }
    return result;
  };

  // Random encounters: each player move advances the world tick and rolls the
  // table. On a hit, announce the event AND emit its text on the narration lane
  // (same broadcast shape combat/quests use) — narration only, no combat autostart.
  const rollEncounterForMove = (pcId) => {
    encounterTick += 1;
    // W5-B: don't stack a random encounter onto a scripted location fight —
    // if the destination already has a living hostile (arrivalCombat NPC etc.)
    // or combat is already active, the tick is still consumed (pacing stays
    // stable) but we skip the roll so it can't spawn a second pile of hostiles.
    const here = ((nextSession.entities.get(pcId) || {}).place || {}).locationId;
    const destinationHasLivingHostile = [...nextSession.entities.values()]
      .some((e) => e?.place?.locationId === here && e?.status?.alive && e?.flags?.hostile);
    if (destinationHasLivingHostile || nextCombat.inCombat()) return;
    const enc = encounterEngine.maybeRoll({ tick: encounterTick });
    if (!enc) return;
    const text = enc.text || enc.prompt || '';
    scopedBroadcast({ type: 'encounter', id: enc.id, name: enc.name, text });
    scopedBroadcast({ type: 'ops', ops: [{ op: 'event', name: 'narration', data: { text, done: true, by: 'dm' } }] });
    if (Array.isArray(enc.hostiles) && enc.hostiles.length && !nextCombat.inCombat()) {
      const spawned = enc.hostiles.map((h) => ({
        op: 'spawn', id: `${enc.id}-${h.id}-t${encounterTick}`,
        components: {
          identity: { name: h.name, kind: 'npc' },
          stats: { hp: h.hp, maxHp: h.hp, armor: 0, level: 1, attack: h.attack, xp: h.xp || 0 },
          status: { alive: true, conditions: [] },
          place: { locationId: here, connections: [] },
          moves: { list: [] },
          flags: { hostile: true, damage: `1d${h.attack}` },
        },
      }));
      const spawnResult = scopedApply(spawned, 'encounter');
      if (spawnResult.ok) {
        nextCombat.beginEncounter({ text: `Encounter: ${enc.name}`, by: pcId })
          .catch((e) => console.error('[encounter] autostart failed', e));
      }
    }
  };

  const nextArtEngine = createArtEngine({ worldDir });
  const nextDmAgent = createDmAgent({ session: nextSession, broadcast: scopedBroadcast, applyAndBroadcast: scopedApply, llm, rulesetPrompt, actorTemplates, defaultCheck: rulesetDefaultCheck });
  const nextNpcAgent = createNpcAgent({ session: nextSession, broadcast: scopedBroadcast, applyAndBroadcast: scopedApply, llm });
  const nextQuestEngine = createQuestEngine({ session: nextSession, broadcast: scopedBroadcast, applyAndBroadcast: scopedApply });
  const nextMemoryEngine = createMemoryEngine({ session: nextSession, applyAndBroadcast: scopedApply, llm });
  const nextCombat = createCombatEngine({ session: nextSession, broadcast: scopedBroadcast, applyAndBroadcast: scopedApply, awardXp: nextQuestEngine.awardXp, rules: rulesetCombat, dmAgent: nextDmAgent, npcAgent: nextNpcAgent, defaultCheck: rulesetDefaultCheck });
  const nextTurnEngine = createTurnEngine({ session: nextSession, broadcast: scopedBroadcast, applyAndBroadcast: scopedApply, dmAgent: nextDmAgent, npcAgent: nextNpcAgent, combat: nextCombat, questEngine: nextQuestEngine, actorTemplates, defaultCheck: rulesetDefaultCheck, onPlayerMove: rollEncounterForMove });

  const routes = new Map();
  const hookCtx = {
    session: nextSession, broadcast: scopedBroadcast, applyAndBroadcast: scopedApply, llm, artEngine: nextArtEngine,
    dmAgent: nextDmAgent, npcAgent: nextNpcAgent, questEngine: nextQuestEngine,
    combat: nextCombat, turnEngine: nextTurnEngine, memoryEngine: nextMemoryEngine, worldDir,
    applyEffects(ops, from = 'addon') {
      return scopedApply(expandOps(nextSession.entities, ops || []), from);
    },
    registerRoute(prefix, handler) {
      if (typeof prefix === 'string' && typeof handler === 'function') routes.set(prefix, handler);
    },
  };
  await runServerHooks(addons, hookCtx);

  return {
    session: nextSession, artEngine: nextArtEngine, dmAgent: nextDmAgent,
    npcAgent: nextNpcAgent, questEngine: nextQuestEngine, memoryEngine: nextMemoryEngine,
    combat: nextCombat, turnEngine: nextTurnEngine, actorTemplates,
    addonRoutes: routes, addonHookCtx: hookCtx, applyAndBroadcast: scopedApply,
    turnChain: Promise.resolve(),
    destroy() {
      active = false;
      try { nextMemoryEngine.destroy?.(); } catch { /* already detached */ }
      nextSession.destroy();
      routes.clear();
    },
  };
}

function customizeProtagonist(targetSession, protagonist, actorTemplates = null) {
  const pcs = [...targetSession.entities.entries()].filter(([, comps]) => comps.identity?.kind === 'pc');
  const selected = pcs.find(([id, comps]) => id === protagonist.templateId || comps.flags?.templateId === protagonist.templateId) || pcs[0];
  if (!selected) throw Object.assign(new Error('Campaign has no protagonist PC'), { status: 400 });
  const [id, comps] = selected;
  const template = actorTemplates?.[protagonist.templateId] || null;
  const name = protagonist.name.trim();
  const ops = [];

  // A ruleset chassis replaces only character data. The seeded entity remains the
  // quest/location/controller anchor, so campaign wiring cannot be orphaned.
  if (template) {
    ops.push({ op: 'set', id, component: 'stats', value: clone(template.stats || {}) });
    ops.push({ op: 'set', id, component: 'moves', value: clone(template.moves || { list: [] }) });
    ops.push({ op: 'merge', id, component: 'flags', value: { ...(comps.flags || {}), tags: clone(template.tags || []) } });
    ops.push({ op: 'merge', id, component: 'identity', value: {
      name: template.name || comps.identity?.name || name,
      description: template.description || '',
    } });
    ops.push({ op: 'set', id, component: 'persona', value: template.persona ? clone(template.persona) : null });
  }

  ops.push(
    { op: 'merge', id, component: 'identity', value: { name } },
    { op: 'merge', id, component: 'agent', value: { enabled: false, controller: name } },
  );
  const description = typeof protagonist.description === 'string' ? protagonist.description.trim() : '';
  if (description) {
    const personality = [template?.persona?.personality || comps.persona?.personality, description].filter(Boolean).join('\n\n');
    const prompt = [comps.art?.prompt, description].filter(Boolean).join(', ');
    ops.push({ op: 'merge', id, component: 'persona', value: { personality } });
    ops.push({ op: 'merge', id, component: 'art', value: { prompt } });
  }
  const result = targetSession.applyOps(ops, 'game-lifecycle');
  if (!result.ok) throw Object.assign(new Error(result.error), { status: 400 });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function activateGame(next, meta) {
  game = next;
  session = next.session;
  artEngine = next.artEngine;
  dmAgent = next.dmAgent;
  npcAgent = next.npcAgent;
  questEngine = next.questEngine;
  memoryEngine = next.memoryEngine;
  combat = next.combat;
  turnEngine = next.turnEngine;
  rulesetActorTemplates = next.actorTemplates;
  addonRoutes = next.addonRoutes;
  addonHookCtx = next.addonHookCtx;
  console.log(`[game] Active campaign ${meta.campaign}, save ${meta.slot}`);
}

const sessionManager = new SessionManager({ rootDir: ROOT_DIR, createGame, activateGame });
await sessionManager.boot({ worldDir: TTRPG_WORLD, ruleset: TTRPG_RULESET, slot: TTRPG_SAVE });

const addonHttp = createAddonHttp({ addons, configFile: addonsConfigFile, rootDir: ROOT_DIR, getHookCtx: () => addonHookCtx });

/**
 * After applying a batch of ops, fire the turn engine for any action ops.
 * Fire-and-forget from the caller's perspective (the HTTP response / WS ack
 * returns immediately; narration streams over WS as it arrives) — but turns
 * are SERIALIZED through a per-session promise chain so two quick actions
 * can never interleave mid-await and corrupt shared turn state.
 */
function triggerTurns(ops, from) {
  const target = game;
  for (const op of ops) {
    if (op.op === 'action' && op.text) {
      target.turnChain = target.turnChain
        .then(() => target.turnEngine.runTurn(op))
        .catch(err => {
          console.error('[turn] Turn error:', err.message);
        });
    }
  }
}

// ---- HTTP helpers ----

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

// ---- Broadcast helpers ----

/**
 * Send a message to open WS clients, filtered per recipient seat.
 * - `audience` gates WHO receives it ('all' | 'dm' | 'players') — DM-only events
 *   (proposals, agent traces) use 'dm' so players never see the machinery.
 * - Each recipient's copy is run through redactForSeat(), so non-DM seats never
 *   receive private components (NPC knowledge/persona/agent internals).
 * @param {object} msg
 * @param {'all'|'dm'|'players'} [audience]
 */
function broadcast(msg, audience = 'all') {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const seat = client._seat || 'player';
    if (!seatSees(audience, seat)) continue;
    const out = redactForSeat(msg, seat);
    if (out) client.send(JSON.stringify(out));
  }
}

/**
 * Validate + apply a batch of ops, then broadcast the resulting ops to all
 * clients (and a fresh snapshot if a reset occurred). Single path for HTTP,
 * WS, presence join/leave — so the wire always carries full op payloads.
 */
function applyAndBroadcast(ops, from) {
  return game.applyAndBroadcast(ops, from);
}

/** Re-run the player→PC binding for every connected player seat (after reset). */
function rebindConnectedPlayers() {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client._seat !== 'player' || !client._who) continue;
    const bind = bindPlayerPc(client._who, session.entities, rulesetActorTemplates);
    if (!bind) continue;
    if (bind.ops.length) session.applyOps(bind.ops, 'system');
    client._pcId = bind.pcId;
    if (client._presenceId && session.entities.has(client._presenceId)) {
      session.applyOps([{ op: 'merge', id: client._presenceId, component: 'presence', value: { pcId: bind.pcId } }], 'system');
    }
    console.log(`[ws] Rebound "${client._who}" → ${bind.pcId} after reset`);
  }
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${TTRPG_PORT}`);

  try {
    // GET /schema
    if (req.method === 'GET' && url.pathname === '/schema') {
      return json(res, SCHEMA);
    }

    // Runtime game lifecycle.
    if (req.method === 'GET' && url.pathname === '/campaigns') {
      return json(res, { campaigns: await sessionManager.publicCampaigns() });
    }

    if (req.method === 'GET' && url.pathname === '/saves') {
      const campaign = url.searchParams.get('campaign');
      if (!campaign) return json(res, { ok: false, error: 'campaign is required' }, 400);
      return json(res, { saves: sessionManager.saves(campaign) });
    }

    if (req.method === 'GET' && url.pathname === '/game') {
      return json(res, sessionManager.info());
    }

    if (req.method === 'POST' && (url.pathname === '/game/new' || url.pathname === '/game/continue')) {
      let payload;
      try { payload = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }

      if (url.pathname === '/game/new') {
        const changed = await sessionManager.newGame(payload);
        broadcast({ type: 'game-changed' });
        return json(res, { ok: true, campaign: changed.campaign, slot: changed.slot });
      }
      await sessionManager.continueGame(payload);
      broadcast({ type: 'game-changed' });
      return json(res, { ok: true });
    }

    // GET /events?since=&limit=
    if (req.method === 'GET' && url.pathname === '/events') {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      return json(res, session.eventsSince(since, limit));
    }

    // POST /op
    if (req.method === 'POST' && url.pathname === '/op') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, { ok: false, error: 'Invalid JSON' }, 400);
      }
      const ops = Array.isArray(payload.ops) ? payload.ops : [payload];
      const from = payload.from || 'http-client';

      const result = applyAndBroadcast(ops, from);
      if (!result.ok) {
        return json(res, { ok: false, error: result.error, applied: result.applied }, result.status || 400);
      }
      // Trigger turn engine for action ops (fire-and-forget)
      triggerTurns(ops, from);
      return json(res, { ok: true, applied: result.applied });
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, {
        status: 'ok',
        entities: session.entities.size,
        journal: session.journal.length,
      });
    }

    // GET /art/tile/<tag> — a tile texture of the AI-painted default tileset.
    if (req.method === 'GET' && url.pathname.startsWith('/art/tile/')) {
      const tag = decodeURIComponent(url.pathname.slice('/art/tile/'.length));
      const tile = await artEngine.tileFor(tag);
      if (!tile) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': tile.mime,
        // Mock tiles must not shadow the real skin after a provider switch.
        'Cache-Control': artEngine.provider === 'mock' ? 'no-store' : 'public, max-age=604800',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(tile.bytes);
      return;
    }

    // GET /art/<entityId> — the entity's art.prompt rendered (cache-first).
    if (req.method === 'GET' && url.pathname.startsWith('/art/')) {
      const entityId = decodeURIComponent(url.pathname.slice('/art/'.length));
      const art = await artEngine.artFor(entityId, session.entities);
      if (!art) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': art.mime,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(art.bytes);
      return;
    }

    // GET /music/<file> — stream a track from musicEngine.tracksDir (P5 event contract).
    if (req.method === 'GET' && url.pathname.startsWith('/music/')) {
      const file = decodeURIComponent(url.pathname.slice('/music/'.length));
      const resolved = path.resolve(musicEngine.tracksDir, file);
      const withinDir = resolved === musicEngine.tracksDir || resolved.startsWith(musicEngine.tracksDir + path.sep);
      const mime = MUSIC_MIME[path.extname(resolved).toLowerCase()];
      if (!withinDir || !mime || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    // POST /voice/narrate — TTS a {text} body through voiceEngine. Mirrors the
    // GET /music/<file> raw-bytes style: 200 + raw audio (Content-Type from the
    // provider result), 204 when the provider is silent (null), 502 on a provider
    // error, 400 on missing/empty text.
    if (req.method === 'POST' && url.pathname === '/voice/narrate') {
      let payload;
      try { payload = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) return json(res, { ok: false, error: 'text is required' }, 400);
      let result;
      try {
        result = await voiceEngine.speak(text);
      } catch (e) {
        return json(res, { error: e.message }, 502);
      }
      if (!result) {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': result.mime,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(result.bytes);
      return;
    }

    // POST /progression/spend — apply one unspent point to a live character stat.
    if (req.method === 'POST' && url.pathname === '/progression/spend') {
      let payload;
      try { payload = JSON.parse(await readBody(req)); }
      catch { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
      if (!payload.stat) return json(res, { ok: false, error: 'stat is required' }, 400);
      if (payload.stat === 'level' || payload.stat === 'xp') {
        return json(res, { ok: false, error: 'stat not spendable' }, 400);
      }
      const selected = payload.entityId
        ? [payload.entityId, session.entities.get(payload.entityId)]
        : [...session.entities.entries()].find(([, comps]) => comps.identity?.kind === 'pc');
      if (!selected || !selected[1]) return json(res, { ok: false, error: 'Entity not found' }, 404);
      const [entityId, entity] = selected;
      if (!progressionEngine.spendPoint(entity, payload.stat)) {
        return json(res, { ok: false, error: 'No unspent points or invalid stat' }, 400);
      }
      const result = applyAndBroadcast([
        { op: 'set', id: entityId, component: 'progression', value: entity.progression },
        { op: 'set', id: entityId, component: 'stats', value: entity.stats },
      ], 'progression');
      if (!result.ok) return json(res, { ok: false, error: result.error }, result.status || 400);
      return json(res, { ok: true, stat: payload.stat, value: entity.stats[payload.stat], unspentPoints: entity.progression.unspentPoints });
    }

    // GET /sense/look
    if (req.method === 'GET' && url.pathname === '/sense/look') {
      return json(res, { ok: true, look: sense.look(session) });
    }

    // GET /sense/recall?q=… — keyword recall over lifelogs + the journal (P6).
    if (req.method === 'GET' && url.pathname === '/sense/recall') {
      const q = url.searchParams.get('q') || '';
      return json(res, { ok: true, query: q, hits: recall(session, q) });
    }

    // GET /sense/describe?id=
    if (req.method === 'GET' && url.pathname === '/sense/describe') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json(res, { ok: false, error: 'Missing id param' }, 400);
      return json(res, { ok: true, description: sense.describe(session, id) });
    }

    // GET /sense/query?has=&kind=
    if (req.method === 'GET' && url.pathname === '/sense/query') {
      const has = url.searchParams.get('has') || undefined;
      const kind = url.searchParams.get('kind') || undefined;
      const at = url.searchParams.get('at') || undefined;
      return json(res, { ok: true, results: sense.query(session, { has, kind, at }) });
    }

    // GET /sense/check
    if (req.method === 'GET' && url.pathname === '/sense/check') {
      return json(res, { ok: true, findings: sense.check(session) });
    }

    // /addons — the addon surface (list / static / config).
    if (await addonHttp(req, res, url)) return;

    // Addon-registered custom routes (first matching prefix wins).
    for (const [prefix, handler] of addonRoutes) {
      if (url.pathname.startsWith(prefix)) {
        if (await handler(req, res, url)) return;
      }
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('[http] Error:', e);
    json(res, { ok: false, error: e.message }, e.status || 500);
  }
});

// ---- WebSocket ----

wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[ws] Client connected');

  // Seat is unknown until `hello`; default to the least-privileged player seat so
  // the immediate snapshot is already redacted. A non-player hello re-sends the
  // entitled view below.
  ws._seat = 'player';
  const initialSnap = redactForSeat(session.snapshot(), ws._seat);
  if (initialSnap) ws.send(JSON.stringify(initialSnap));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    // Hello — register presence + lock in this client's seat for redaction.
    if (msg.type === 'hello') {
      const pres = msg.presence || { seat: 'player', who: 'anonymous', mode: 'play' };
      ws._seat = pres.seat || 'player';
      ws._who = pres.who || 'anonymous';

      // Multiplayer: a player seat binds to a PC — reclaim its own, claim the
      // first unbound one, or spawn a fresh party member from the PC chassis.
      if (ws._seat === 'player' && pres.who) {
        const bind = bindPlayerPc(pres.who, session.entities, rulesetActorTemplates);
        if (bind) {
          if (bind.ops.length) applyAndBroadcast(bind.ops, 'system');
          pres.pcId = bind.pcId;
          ws._pcId = bind.pcId;
          const pcName = ((session.entities.get(bind.pcId) || {}).identity || {}).name || bind.pcId;
          console.log(`[ws] Player "${pres.who}" drives ${bind.pcId} (${pcName})`);
        }
      }

      const presenceId = msg.presenceId || `presence-${Date.now()}`;
      applyAndBroadcast([{ op: 'spawn', id: presenceId, components: { presence: pres } }], 'system');
      ws._presenceId = presenceId; // remembered for cleanup on disconnect
      // A privileged seat (e.g. dm) is entitled to more than the player snapshot it
      // got on connect — re-send the seat-appropriate (unredacted) view.
      if (ws._seat !== 'player') {
        const snap = redactForSeat(session.snapshot(), ws._seat);
        if (snap) ws.send(JSON.stringify(snap));
      }
      // A DM joining after proposals were staged needs to see the backlog.
      if (ws._seat === 'dm') {
        for (const proposal of turnEngine.listProposals()) {
          ws.send(JSON.stringify({ type: 'proposal', proposal }));
        }
      }
      return;
    }

    // Ops batch
    if (msg.type === 'ops') {
      const result = applyAndBroadcast(msg.ops || [], msg.from || 'ws-client');
      if (!result.ok) {
        ws.send(JSON.stringify({ type: 'error', error: result.error }));
        return;
      }
      // Trigger turn engine for action ops (fire-and-forget)
      triggerTurns(msg.ops || [], msg.from || 'ws-client');
      return;
    }

    // DMView control (Slice 2) — DM seats only: toggle autopilot, resolve proposals.
    if (msg.type === 'dm-control') {
      if (ws._seat !== 'dm') {
        ws.send(JSON.stringify({ type: 'error', error: 'dm-control requires a DM seat' }));
        return;
      }
      if (msg.action === 'setAutopilot') {
        turnEngine.setAutopilot(!!msg.value);
        return;
      }
      // P5: the DM's mood knob — drives every client's music engine (and is
      // readable by the LLM via world flags). value: calm|eerie|tense|combat|
      // somber, or null/'' to hand mood control back to the world.
      if (msg.action === 'setMood') {
        const mood = ['calm', 'eerie', 'tense', 'combat', 'somber'].includes(msg.value) ? msg.value : null;
        applyAndBroadcast([{ op: 'merge', id: 'world-state', component: 'flags', value: { mood } }], 'dm');
        return;
      }
      // D5: a human DM (DMView) stages the next beat — spawns/checks/beginCombat — that
      // the turn engine RESOLVEs exactly like an LLM ruling (same ops, same world-first).
      if (msg.action === 'stage') {
        turnEngine.injectDmRuling(msg.ruling || {});
        return;
      }
      // approve | reject | regenerate
      turnEngine.resolveProposal(msg.proposalId, msg.action)
        .catch(err => console.error('[dm-control] resolve error:', err.message));
      return;
    }
  });

  ws.on('close', () => {
    if (ws._presenceId) {
      applyAndBroadcast([{ op: 'despawn', id: ws._presenceId }], 'system');
    }
    console.log('[ws] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[ws] Error:', err.message);
  });
});

// ---- Start ----

server.listen(TTRPG_PORT, () => {
  console.log(`[server] HTTP + WS listening on port ${TTRPG_PORT}`);
  console.log(`[server] World: ${sessionManager.current.worldDir}`);
  console.log(`[server] Save slot: ${sessionManager.current.slot}`);
});

// Graceful shutdown: flush the debounced save so Ctrl-C never loses the last turn.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — flushing save…`);
    try { session.flushSave(); } catch (e) { console.error('[server] flush failed:', e.message); }
    process.exit(0);
  });
}
