/**
 * server/turn.js — the turn engine (orchestrator). P3: action→consequence loop.
 *
 * Triggered when a client emits an action op.
 * NEW FLOW (P3):
 *   1. @name match → fast-path to that NPC (no LLM), npcAgent.respond(...), done.
 *   2. Otherwise → dmAgent.adjudicate(action, presentNpcs):
 *      a. If speakTo set → npcAgent.respond(speakTo, text, note) (conversation), done.
 *      b. Else (world action):
 *         - Resolve each checks[] via shared/checks.js + session.rng() (ENGINE rolls).
 *         - Broadcast roll results as event:system.
 *         - dmAgent.narrateOutcome(action, checkResults) (stream narration).
 *         - Expand + apply consequence ops (adjudication ops for success case).
 *         - Guard: ignore ops targeting pc/presence despawns.
 */

import { presentAgents as sensePresentAgents, look as senseLook } from './sense.js';
import { resolveCheck, formatCheckResult } from '../shared/checks.js';
import { expandOp } from '../shared/effects.js';
import { validateOp } from '../shared/ops.js';
import { resolveExit, isConnected, pcLocationId, findPcFor, locationOf, findPcs } from '../shared/space.js';
import { resolveActorSpawn } from '../shared/staging.js';
import { tick as clockTick, phaseBanner, scheduleMoves, ambientLine } from '../shared/clock.js';

/**
 * Movement-intent gate for the deterministic fast-path. The text must READ like
 * travel before we try to match it to an exit — anchored at the start so it can't
 * false-trigger on "examine the door to the docks". An optional polite preamble
 * ("I'd like to", "let's", "can we") may precede the movement verb. If the verb is
 * present but no exit matches, we fall through to LLM adjudication (move backstop).
 */
export const MOVE_INTENT_RE = /^\s*(?:(?:i(?:'d| would)?\s+(?:like|want|wish|love|need)\s+to|i\s+(?:wanna|want to)|let'?s|let us|can we|could we|shall we|time to|off)\s+)?(?:go|move|walk|head|travel|journey|venture|proceed|return|leave|exit|enter|run|step|climb|descend|cross|wander|stroll|visit|approach|make (?:my|our) way|set off|set out)\b/i;

/** "[Kid] hello" — name the speaking party member so NPCs address the right one. */
function speakerPrefix(pcEntry, text) {
  const name = pcEntry && pcEntry[1] && pcEntry[1].identity && pcEntry[1].identity.name;
  return name ? `[${name}] ${text}` : text;
}

/**
 * Create the turn engine.
 *
 * @param {object} params
 * @param {import('./session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm
 * @param {object} params.dmAgent
 * @param {object} params.npcAgent
 * @param {(pcId:string, targetId:string)=>void} [params.onPlayerMove] — called with (pcId, targetId) after a player move applies — index.js uses it to advance the encounter tick.
 * @returns {{runTurn: (actionOp:object) => Promise<void>}}
 */
export function createTurnEngine({ session, broadcast, applyAndBroadcast, dmAgent, npcAgent, combat, questEngine, actorTemplates, defaultCheck, onPlayerMove }) {
  /**
   * Move the PC to a connected location, then narrate the arrival.
   * The move itself is engine-applied (deterministic, already canon) so we do
   * NOT canonize the arrival prose — it only describes the new room.
   *
   * @param {string} pcId
   * @param {string} targetId — destination location id (already validated as connected)
   * @param {object} actionOp — the originating player action (for narration context)
   */
  async function doMove(pcId, targetId, actionOp) {
    await applyConsequences([{ op: 'move', id: pcId, to: targetId }], session, applyAndBroadcast);
    if (onPlayerMove) {
      try { onPlayerMove(pcId, targetId); }
      catch (e) { console.warn(`[turn] onPlayerMove hook failed: ${e.message}`); }
    }
    // Fresh scene frame for the NEW location; narrate arrival against it.
    await dmAgent.narrateOutcome(actionOp, [], senseLook(session));
  }

  /**
   * Public entry: run the turn, then re-evaluate quests/progression (P6) on EVERY
   * path (combat, movement, talk, world action) via a finally — so triggers fire
   * off whatever just happened (reached a location, took an item, won a fight).
   * @param {object} actionOp — {op:'action', text, by}
   */
  async function runTurn(actionOp) {
    try {
      await runTurnInner(actionOp);
    } finally {
      if (questEngine) {
        try { await questEngine.evaluate(); }
        catch (e) { console.error('[turn] quest evaluate error:', e.message); }
      }
      // P4: the world breathes — time passes on every world action.
      try { await tickWorld(); }
      catch (e) { console.error('[turn] clock tick error:', e.message); }
    }
  }

  /**
   * Advance the world clock one tick (frozen mid-encounter). On a phase change:
   * banner it, walk scheduled NPCs on their rounds, and surface each occupied
   * location's ambient line. Deterministic — the world breathes without an LLM;
   * the DM stages richer beats on top through the normal staging path.
   */
  async function tickWorld() {
    const enc = (session.entities.get('encounter') || {}).encounter || {};
    if (enc.active) return;
    const ws = session.entities.get('world-state');
    if (!ws) return;

    const { clock, phaseChanged } = clockTick(ws);
    applyAndBroadcast([{ op: 'merge', id: 'world-state', component: 'clock', value: clock }], 'system');
    if (!phaseChanged) return;

    applyAndBroadcast([{
      op: 'event', name: 'system',
      data: { kind: 'clock', day: clock.day, phase: clock.phase, text: phaseBanner(clock) },
    }], 'system');

    // NPCs make their rounds. Visible notes only where a party member stands.
    const pcLocs = new Set(findPcs(session.entities).map(([, c]) => (c.place || {}).locationId).filter(Boolean));
    const moves = scheduleMoves(session.entities, clock.phase);
    for (const mv of moves) {
      const npc = session.entities.get(mv.id) || {};
      const from = (npc.place || {}).locationId;
      await applyConsequences([mv], session, applyAndBroadcast);
      if (pcLocs.has(from) || pcLocs.has(mv.to)) {
        const name = (npc.identity || {}).name || mv.id;
        const destName = ((session.entities.get(mv.to) || {}).identity || {}).name || mv.to;
        applyAndBroadcast([{
          op: 'event', name: 'system',
          data: { kind: 'ambient', text: pcLocs.has(mv.to) ? `${name} arrives.` : `${name} heads for ${destName}.` },
        }], 'system');
      }
    }

    // Ambient flavor where the party stands.
    for (const locId of pcLocs) {
      const line = ambientLine(session.entities.get(locId), clock.phase, clock.day);
      if (line) {
        applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'ambient', text: line } }], 'system');
      }
    }
  }

  /**
   * Orchestrate a turn with full adjudication → checks → narration → consequences.
   * @param {object} actionOp — {op:'action', text, by}
   */
  async function runTurnInner(actionOp) {
    const actionText = (actionOp.text || '').trim();
    if (!actionText) return;

    try {
      // 0. Resolve the ACTING PC from the action's sender (multiplayer: each player
      //    drives their own PC; single-player falls back to the first PC).
      const pcEntry = findPcFor(session.entities, actionOp.by);
      const pcId = pcEntry ? pcEntry[0] : null;
      const pcStats = (pcEntry && pcEntry[1].stats) || {};

      // 0.05 Death gate (no LLM): a dead PC cannot act. Short-circuit before the
      //      movement fast-path, combat, or any adjudication — strictly
      //      status.alive === false; missing/undefined status or alive:true acts
      //      exactly as before.
      const pcStatus = pcEntry && pcEntry[1].status;
      if (pcId && pcStatus && pcStatus.alive === false) {
        applyAndBroadcast([{
          op: 'event', name: 'system',
          data: { kind: 'death', pcId, text: 'You are dead. The wasteland is done with you — load a save or start again.' },
        }], 'system');
        return;
      }

      // 0.1 Turn-local scene frame + present agent-NPCs, scoped to the acting PC
      const lookText = senseLook(session, pcId);
      const presentNpcs = sensePresentAgents(session, pcId);
      const pcProficiency = pcStats.proficiency || 2;
      const here = pcId ? locationOf(session.entities, pcId) : pcLocationId(session.entities);

      // 2. @name fast-path (no LLM) → route to matched NPC directly
      const atMatch = actionText.match(/@(\S+)/);
      if (atMatch) {
        const token = atMatch[1].toLowerCase();
        for (const npc of presentNpcs) {
          const npcName = (npc.name || '').toLowerCase();
          // Match any word of the name: "@Travine" reaches "Wirtin Travine".
          const words = npcName.split(/\s+/);
          if (npcName.startsWith(token) || words.some(w => w.startsWith(token))) {
            const cleanText = actionText.replace(/@\S+\s*/, '').trim() || 'Hello.';
            await npcAgent.respond(npc.npcId, speakerPrefix(pcEntry, cleanText), '', pcId);
            return;
          }
        }
        // @mention but no match → fall through to adjudication
      }

      // 2.5 Movement fast-path (deterministic, no LLM): the action must read like
      //     travel AND resolve unambiguously to a connected exit.
      if (pcId && here && MOVE_INTENT_RE.test(actionText)) {
        const target = resolveExit(session.entities, here, actionText);
        if (target) {
          await doMove(pcId, target, actionOp);
          return;
        }
        // ambiguous / no exit matched → fall through to adjudication (move backstop)
      }

      // 2.6 Combat (no LLM): if an encounter is active, every action is a combat action.
      if (combat && combat.inCombat()) {
        await combat.handlePlayerAction(actionOp);
        return;
      }

      // 2.7 Combat initiation (no LLM): attacking a present HOSTILE starts a structured
      //     encounter. Attacking a non-hostile NPC falls through to the narrative path.
      if (combat) {
        const initiation = combat.detectInitiation(actionOp);
        if (initiation) {
          await combat.startAndResolve(actionOp, initiation);
          return;
        }
      }

      // 3. Produce the DM's PROPOSED ruling through the seat-controller indirection
      //    (D5): a human/DMView injection wins; otherwise the 'ai' responder (LLM).
      const { ruling, source } = await produceRuling(actionOp, presentNpcs, lookText);
      emitTrace({ agent: 'dm', phase: 'adjudicate', by: source, summary: `${source === 'ai' ? '' : `(${source}) `}${summarizeRuling(ruling, actionText)}`, detail: ruling });

      // 3.1 GATE (DMView Slice 2): when paused (autopilot off), don't execute the ruling —
      //     stage it as a proposal for the DM to approve / reject / regenerate. The
      //     deterministic fast-paths above (movement/combat/@name) are never gated; only
      //     LLM rulings are. Autopilot on → execute immediately (the original behavior).
      if (isPaused()) {
        stageProposal(actionOp, ruling);
        return;
      }

      await executeRuling(actionOp, ruling);

    } catch (err) {
      console.error('[turn] Turn engine error:', err.message);
      broadcast({
        type: 'ops',
        ops: [{
          op: 'event',
          name: 'narration',
          data: {
            text: `(The dungeon master pauses — a shadow passes over the world. Perhaps try again?)`,
            done: true,
            by: 'dm',
          },
        }],
      });
    }
  }

  /**
   * Execute an adjudicated ruling: movement backstop → speakTo → checks → narrate →
   * canonize. Split out from runTurnInner so the DM gate can defer it until approval.
   * Re-derives PC/location context at call time (state may have advanced since the
   * proposal was staged).
   * @param {object} actionOp
   * @param {object} ruling — from dmAgent.adjudicate()
   */
  /**
   * Spawn each staged actor into the world (world-first). Returns the new ids.
   * Gated on the ruleset shipping actorTemplates; spec.place defaults to the PC's
   * location so spawns land where the player is. Applied individually so each
   * subsequent unique-id check sees the prior spawn.
   * @param {object[]} spawns — normalized specs from the ruling
   * @param {string|null} here — the PC's current location id
   * @returns {string[]}
   */
  function stageSpawns(spawns, here) {
    if (!actorTemplates || !Array.isArray(spawns) || !spawns.length) return [];
    const ids = [];
    for (const spec of spawns) {
      const spawnOp = resolveActorSpawn({ ...spec, place: spec.place || here }, actorTemplates, session.entities);
      if (!spawnOp) continue;
      applyAndBroadcast([spawnOp], 'dm');
      ids.push(spawnOp.id);
      emitTrace({
        agent: 'dm', phase: 'stage',
        summary: `spawned ${spawnOp.components.identity.name}${spawnOp.components.flags && spawnOp.components.flags.hostile ? ' (hostile)' : ''} → ${spawnOp.id}`,
        detail: spawnOp,
      });
    }
    return ids;
  }

  async function executeRuling(actionOp, ruling) {
    const actionText = (actionOp.text || '').trim();

    const pcEntry = findPcFor(session.entities, actionOp.by);
    const pcId = pcEntry ? pcEntry[0] : null;
    const pcStats = (pcEntry && pcEntry[1].stats) || {};
    const pcProficiency = pcStats.proficiency || 2;
    const here = pcId ? locationOf(session.entities, pcId) : pcLocationId(session.entities);
    let lookText = senseLook(session, pcId);

    // 3.5 Movement decided by the LLM (natural-language backstop).
    if (pcId && ruling.move && ruling.move.to) {
      const dest = ruling.move.to;
      if (here && isConnected(session.entities, here, dest)) {
        await doMove(pcId, dest, actionOp);
        return;
      }
      applyAndBroadcast([{
        op: 'event', name: 'system',
        data: { kind: 'note', text: `(You can't reach "${dest}" directly from here.)` },
      }], 'system');
      // fall through to a plain outcome narration (no checks).
    }

    // 4. speakTo path → NPC conversation
    if (ruling.speakTo) {
      emitTrace({ agent: 'npc', phase: 'respond', summary: `${ruling.speakTo} responds to the player`, detail: { note: ruling.note || '' } });
      await npcAgent.respond(ruling.speakTo, speakerPrefix(pcEntry, actionText), ruling.note || '', pcId);
      return;
    }

    // 4.5 STAGE → RESOLVE (world-first): any actor the DM is about to narrate is
    // spawned into the world NOW, before the prose describes it. Applied one at a
    // time so ids stay unique; the scene frame is refreshed so RENDER sees them.
    const spawnedIds = stageSpawns(ruling.spawns, here);
    if (spawnedIds.length) lookText = senseLook(session, pcId);

    // 5. World action: resolve checks via ENGINE
    const checkResults = [];
    for (const checkReq of ruling.checks || []) {
      const rng = session.rng(); // deterministic, advances rollCount
      // The ruleset's default check kind wins (necro-test / …); an explicit
      // per-check kind from the ruling wins over that; bare 5e is the fallback.
      const kind = checkReq.check || (defaultCheck && defaultCheck.kind) || 'ability-check';
      // ?? not ||: dc 0 is meaningful in roll-under systems (DSA Erschwernis ±0).
      const dcFallback = (defaultCheck && defaultCheck.dcDefault) ?? 12;
      const result = resolveCheck(
        {
          check: kind,
          ability: checkReq.ability || 'wis',
          skill: checkReq.skill,
          dc: checkReq.dc ?? dcFallback,
          reason: checkReq.reason || '',
        },
        { stats: pcStats, proficiency: pcProficiency },
        rng,
      );
      result.reason = checkReq.reason || '';
      result.def = (checkReq.skill || checkReq.ability || kind);
      checkResults.push(result);

      applyAndBroadcast([{
        op: 'event', name: 'system',
        data: {
          kind: 'roll',
          text: formatCheckResult(result),
          detail: {
            check: checkReq.ability, skill: checkReq.skill, dc: checkReq.dc,
            rolls: result.rolls, modifier: result.modifier, total: result.total,
            success: result.success, crit: result.crit, fumble: result.fumble,
            reason: checkReq.reason,
          },
        },
      }], 'system');
    }

    // 5.5 DM-initiated combat (world-first): the DM staged the hostiles above and asked
    // to open the floor. Hand off to the same combat path a player attack uses; if it
    // starts, combat owns the start banner + flavor — skip the generic RENDER/VALIDATE.
    if (ruling.beginCombat && combat && typeof combat.beginEncounter === 'function') {
      const started = await combat.beginEncounter(actionOp);
      if (started) {
        emitTrace({ agent: 'dm', phase: 'begin-combat', summary: 'DM opened the floor with the staged hostiles', detail: { spawned: spawnedIds } });
        return;
      }
    }

    // 6. Narrate the outcome (grounded in the scene + the rolled results).
    const narrationText = await dmAgent.narrateOutcome(actionOp, checkResults, lookText);

    // 7. VALIDATE (demoted canonize): distill incidental changes into ops AND catch any
    // interactable actor the prose named that isn't grounded — the world-first backstop.
    const canon = await dmAgent.canonize(actionOp, narrationText, checkResults);
    const canonOps = (canon && canon.ops) || [];
    emitTrace({ agent: 'dm', phase: 'canonize', summary: `${canonOps.length} consequence op(s)`, detail: canonOps });
    if (canonOps.length > 0) {
      await applyConsequences(canonOps, session, applyAndBroadcast);
    }

    // Grounding backstop: spawn any ungrounded named actor so no pure-text character
    // survives the turn. World-first should make this empty; a hit means RENDER strayed.
    // An actor whose name overlaps an EXISTING entity ("the officiant" ≈ "Padre Salt"
    // won't match, but "Padre" or "Salt" will) is the LLM re-describing someone present
    // — never a reason to spawn a twin.
    const ungrounded = (canon && canon.actors) || [];
    if (ungrounded.length) {
      const existingNames = [...session.entities.values()]
        .map(c => ((c.identity || {}).name || '').toLowerCase())
        .filter(Boolean);
      const isKnown = (name) => {
        const n = name.toLowerCase();
        return existingNames.some(e =>
          e === n || e.includes(n) || n.includes(e) ||
          e.split(/\s+/).some(w => w.length > 2 && n.includes(w))
        );
      };
      const specs = ungrounded
        .filter(a => a && typeof a === 'object' && a.name && !isKnown(String(a.name)))
        .map(a => ({ archetype: a.archetype ? String(a.archetype) : undefined, name: String(a.name), hostile: a.hostile === true || undefined }));
      if (specs.length) {
        emitTrace({ agent: 'dm', phase: 'grounding', summary: `backstop: spawning ${specs.length} ungrounded actor(s) the prose named`, detail: specs });
        stageSpawns(specs, pcId ? locationOf(session.entities, pcId) : pcLocationId(session.entities));
      }
    }
  }

  // ---- DMView: pause/propose gate (Slice 2) + agent traces (Slice 3) ----

  const pendingProposals = new Map(); // id → {id, actionOp, ruling, actionText, summary, createdAt}
  let proposalSeq = 0;

  /** True when the DM gate is engaged (dm-control.dmControl.autopilot === false). */
  function isPaused() {
    const ctrl = session.entities.get('dm-control');
    return !!(ctrl && ctrl.dmControl && ctrl.dmControl.autopilot === false);
  }

  /** Flip autopilot on/off (merge onto the dm-control singleton; broadcast to all). */
  function setAutopilot(on) {
    applyAndBroadcast([{ op: 'merge', id: 'dm-control', component: 'dmControl', value: { autopilot: !!on } }], 'dm');
  }

  // ---- DM seat-controller indirection (D5; DESIGN-NOTES #1) ----
  //
  // "Produce a ruling for the DM seat" is dispatched through a responder lookup, not a
  // hardcoded LLM call. Today it resolves to the LLM ('ai') OR a human/DMView injection;
  // both emit the SAME ruling shape, so the DM can be AI, human, or both interchangeably
  // without the RESOLVE path caring who authored the beat.

  /** The empty ruling skeleton every source fills in (LLM coercion or human inject). */
  function defaultRuling() {
    return { speakTo: null, move: null, note: '', checks: [], ops: [], spawns: [], beginCombat: false };
  }

  /** The DM seat's controller: 'ai' (LLM) by default, or a clientId when a human holds it. */
  function dmSeatController() {
    const ctrl = session.entities.get('dm-control');
    return (ctrl && ctrl.dmControl && ctrl.dmControl.controller) || 'ai';
  }

  // A human/DMView (or both) supplies the next DM ruling. Queued for the next player
  // action; a queued human beat takes precedence over the LLM (co-drive: human wins).
  let pendingDmRuling = null;
  function injectDmRuling(ruling) {
    const next = { ...defaultRuling(), ...(ruling || {}) };
    // Same normalization the LLM path gets in adjudicate(): expand count× and
    // drop malformed specs, so a DMView-staged beat behaves identically.
    if (Array.isArray(next.spawns)) {
      const out = [];
      for (const s of next.spawns) {
        if (!s || typeof s !== 'object') continue;
        const n = Math.max(1, Math.min(8, Math.round(Number(s.count) || 1)));
        const spec = {
          archetype: s.archetype ? String(s.archetype) : undefined,
          name: s.name ? String(s.name) : undefined,
          hostile: s.hostile === true || undefined,
          ally: s.ally === true || undefined,
        };
        for (let i = 0; i < n; i++) out.push({ ...spec });
      }
      next.spawns = out;
    }
    pendingDmRuling = next;
  }

  /**
   * Produce the DM's ruling for this action via the seat indirection: a queued human
   * ruling wins; else the 'ai' responder (the LLM) produces it. Same shape either way.
   * @returns {Promise<{ruling:object, source:string}>}
   */
  async function produceRuling(actionOp, presentNpcs, lookText) {
    if (pendingDmRuling) {
      const ruling = pendingDmRuling;
      pendingDmRuling = null;
      const ctrl = dmSeatController();
      return { ruling, source: ctrl === 'ai' ? 'injected' : ctrl };
    }
    const ruling = await dmAgent.adjudicate(actionOp, presentNpcs, lookText);
    return { ruling, source: 'ai' };
  }

  /** One-line human summary of a ruling for the proposal card. */
  function summarizeRuling(ruling, actionText) {
    if (ruling.move && ruling.move.to) return `Move the party → ${ruling.move.to}`;
    if (ruling.speakTo) return `${ruling.speakTo} answers the player`;
    const parts = [];
    if (ruling.spawns && ruling.spawns.length) parts.push(`spawn ${ruling.spawns.length} actor(s)`);
    if (ruling.beginCombat) parts.push('begin combat');
    if (ruling.checks && ruling.checks.length) {
      parts.push('roll ' + ruling.checks.map(c => `${c.ability || '?'}${c.skill ? '/' + c.skill : ''} DC${c.dc || '?'}`).join(', '));
    }
    if (ruling.ops && ruling.ops.length) parts.push(`${ruling.ops.length} consequence op(s)`);
    return parts.length ? parts.join(' · ') : 'Narrate the outcome';
  }

  /** Emit a DM-only trace of an agent decision / tool call (Slice 3). */
  function emitTrace(trace) {
    broadcast({ type: 'trace', trace: { ...trace, t: Date.now() } }, 'dm');
  }

  /** Stage a ruling as a pending proposal + notify the DM (+ a vague note to players). */
  function stageProposal(actionOp, ruling) {
    const id = `prop-${++proposalSeq}`;
    const actionText = (actionOp.text || '').trim();
    const summary = summarizeRuling(ruling, actionText);
    pendingProposals.set(id, { id, actionOp, ruling, actionText, summary, createdAt: Date.now() });
    broadcast({ type: 'proposal', proposal: { id, actionText, summary, ruling } }, 'dm');
    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'note', text: '(The dungeon master considers your action…)' } }], 'system');
  }

  /** Pending proposals (for a DM that connects AFTER they were staged). */
  function listProposals() {
    return [...pendingProposals.values()].map(({ id, actionText, summary, ruling }) => ({ id, actionText, summary, ruling }));
  }

  /**
   * DM resolves a proposal: 'approve' → execute the ruling, 'reject' → drop it,
   * 'regenerate' → re-adjudicate and replace it.
   * @param {string} id
   * @param {'approve'|'reject'|'regenerate'} action
   */
  async function resolveProposal(id, action) {
    const pending = pendingProposals.get(id);
    if (!pending) return;

    if (action === 'reject') {
      pendingProposals.delete(id);
      broadcast({ type: 'proposal-resolved', id, action: 'reject' }, 'dm');
      applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'note', text: '(The dungeon master lets the moment pass.)' } }], 'system');
      return;
    }

    if (action === 'regenerate') {
      const presentNpcs = sensePresentAgents(session);
      const ruling = await dmAgent.adjudicate(pending.actionOp, presentNpcs, senseLook(session));
      const summary = summarizeRuling(ruling, pending.actionText);
      emitTrace({ agent: 'dm', phase: 'adjudicate', summary: `(regen) ${summary}`, detail: ruling });
      pendingProposals.set(id, { ...pending, ruling, summary });
      broadcast({ type: 'proposal', proposal: { id, actionText: pending.actionText, summary, ruling } }, 'dm');
      return;
    }

    // approve
    pendingProposals.delete(id);
    broadcast({ type: 'proposal-resolved', id, action: 'approve' }, 'dm');
    try {
      await executeRuling(pending.actionOp, pending.ruling);
    } finally {
      if (questEngine) {
        try { await questEngine.evaluate(); }
        catch (e) { console.error('[turn] quest evaluate error:', e.message); }
      }
    }
  }

  return { runTurn, isPaused, setAutopilot, resolveProposal, listProposals, injectDmRuling };
}

/**
 * Expand semantic ops → canonical ops, validate, and apply.
 * Guards: ignore ops that would despawn a pc/presence entity.
 *
 * @param {object[]} ops — proposed ops (may be semantic or canonical)
 * @param {import('./session.js').Session} session
 * @param {(ops:object[], from:string)=>object} applyAndBroadcast
 */
async function applyConsequences(ops, session, applyAndBroadcast) {
  const canonicalOps = [];

  for (const op of ops) {
    let expanded;
    try {
      expanded = expandOp(session.entities, op);
    } catch (err) {
      console.warn(`[turn] Skipping malformed consequence op ${op && op.op}: ${err.message}`);
      continue;
    }
    for (const canonOp of expanded) {
      // Guard: no despawn of pc or presence entities
      if (canonOp.op === 'despawn') {
        const comps = session.entities.get(canonOp.id);
        if (comps && (comps.presence || ((comps.identity || {}).kind === 'pc'))) {
          console.warn(`[turn] Ignoring despawn op targeting protected entity ${canonOp.id}`);
          continue;
        }
      }

      // Validate
      const validation = validateOp(canonOp);
      if (!validation.ok) {
        console.warn(`[turn] Invalid consequence op: ${validation.error}`);
        continue;
      }

      canonicalOps.push(canonOp);
    }
  }

  if (canonicalOps.length > 0) {
    const result = applyAndBroadcast(canonicalOps, 'dm');
    if (!result.ok) {
      console.error('[turn] Consequence apply failed:', result.error);
    }
  }
}
