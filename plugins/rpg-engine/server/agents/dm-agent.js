/**
 * server/agents/dm-agent.js — DM director agent.
 *
 * The DM is the world-voice: narrates environment, routes player input to NPCs,
 * AND adjudicates actions for checks + consequences (P3).
 * Does NOT speak for NPCs — those are independent agent-clients.
 */

import { z } from 'zod';
import { streamBeat } from './stream-beat.js';
import { look as senseLook } from '../sense.js';
import { findPcFor } from '../../shared/space.js';

// ---- 5e system prompt for the DM (narration voice) ----

const DM_SYSTEM_PROMPT = `You are the Dungeon Master of a Dungeons & Dragons 5th Edition game.

Your role:
- Narrate vividly but concisely in 2nd person ("You see...", "You feel...").
- Describe the scene, NPC reactions, and consequences of player actions.
- Rely on your knowledge of 5e rules for any checks, combat, or spellcasting.

Guidelines:
- Keep narration to 2-4 sentences unless the situation demands more.
- Be specific about sensory details — what is seen, heard, smelled, felt.
- Maintain consistent tone matching the scene's mood.
- Track NPC attitudes and world state implicitly.
- Do NOT break character or address the player out-of-game.
- Respond with prose ONLY — never JSON or code blocks.

When told check results, INCORPORATE them into your narration naturally:
- Success → describe the character succeeding ("Your blade bites deep...", "The lock clicks open...").
- Failure → describe the consequence ("Your footing slips...", "The mechanism jams...").
- Crit → a spectacular success ("A perfect strike...").
- Fumble → a spectacular failure ("Disaster strikes...").

Always stay in the fiction. You are the world.`;

// ---- Adjudication system prompt (referee voice) ----

const ADJUDICATE_SYSTEM_PROMPT = `You are the DM referee. For each player action, decide:
1. Does the action target an NPC for conversation? → set speakTo to that npcId.
2. Does the player want to TRAVEL to a connected place? → set move:{"to":"<locationId>"}
   using an EXACT targetId from the scene's Exits list. NEVER move to a place that is
   not listed as an exit. When moving, leave checks and ops empty — arrival is narrated separately.
3. Does the action require dice checks? → list them in "checks" using the exact shape
   the reply format specifies. You must NEVER invent dice values — only REQUEST checks. The engine rolls.
4. Does the action have certain consequences? → provide semantic ops.
   - If a check is requested: provide ops for the SUCCESS case only.
   - For no-check actions: provide ops directly.
   - To PICK UP a world object that is present in the scene, use
     {op:'take', id:<PC_ID>, item:{id:<the item's entity id>, name:<Name>}} — NOT giveItem.

IMPORTANT: Only reference NPCs, items, and exits that appear in the scene below.
The player can only interact with what is HERE.

Available semantic ops:
- {op:'take', id:<PC_ID>, item:{id:<itemEntityId>, name:<displayName>}} — pick up a PRESENT world object
- {op:'damage', id:<entityId>, amount:<number>} — deal damage (engine computes new hp)
- {op:'heal', id:<entityId>, amount:<number>} — heal (engine caps at maxHp)
- {op:'giveItem', id:<entityId>, item:{id:<itemId>, name:<displayName>}} — abstract grant with NO world entity
- {op:'setFlag', key:<string>, value:<any>, id?<world-state-id>}
- {op:'merge', id:<npcId>, component:'disposition', value:{value:<number>}} — you MAY shift an NPC's attitude toward the party when their actions warrant it, keeping the new value within the disposition tracker's range (default -100 to 100).

Respond with JSON ONLY. No narration, no commentary.`;

// ---- Combat improv adjudication prompt (C3 — off-menu combat actions) ----

const COMBAT_ADJUDICATE_PROMPT = `You are the DM referee adjudicating an IMPROVISED combat action — something OFF the Move menu ("I throw sand in its eyes", "I kick the brazier over", "I shove it off the ledge"). The engine handles declared Moves; YOU only handle the creative one-off.

Decide:
1. What SINGLE check (if any) gates it? Request it: {check, dc, reason}. Use the ruleset's check kind. NEVER invent dice values — the engine rolls.
2. What ops happen on SUCCESS? Prefer:
   - {op:'applyStatus', id:<enemyId>, kind:'blind'|'stun'|'armor-break'|'bleed', magnitude?, remaining:<turns>} to debuff a foe
   - {op:'damage', id:<enemyId>, amount:N} for direct harm
   - {op:'spawnHazard', zoneId, kind, magnitude, remaining} to set a surface alight (C4)
Only reference the living enemy ids listed. Respond JSON ONLY: {"checks":[...], "ops":[...]}.`;

// ---- Canonize system prompt (canon-recorder voice; "narrate freely, canonize second") ----

const CANONIZE_SYSTEM_PROMPT = `You are the DM's canon-recorder. You read the narration that was JUST delivered to the player and output the concrete world-state changes it ESTABLISHED, as semantic ops in JSON.

Be THOROUGH about concrete changes — even if the narration also contains description or dialogue, extract EVERY concrete change inside it:
- The player picks up / takes / grabs / loots / pockets an object that EXISTS in the scene below → {"op":"take","id":"<PC_ID>","item":{"id":"<that item's entity id>","name":"<Name>"}}
- The player is granted something that has NO entity in the scene (coins, a note, abstract loot) → {"op":"giveItem","id":"<PC_ID>","item":{"id":"<slug>","name":"<Name>"}}
- The player loses / drops / uses up / hands over an item → {"op":"takeItem","id":"<PC_ID>","item":{"id":"<slug>"}}
- The player or a target takes damage → {"op":"damage","id":"<entityId>","amount":N}; is healed → {"op":"heal","id":"<entityId>","amount":N}
- A world fact becomes true → {"op":"setFlag","key":"<k>","value":<v>}

Rules:
- Record ONLY what the narration actually made true (it already reflects success/failure — a FAILED attempt changes nothing).
- Do NOT invent changes the narration didn't describe.
- Do NOT record movement between locations — travel is handled by the engine separately.
- Prefer the EXACT item entity ids shown in the scene below when the object is already present.
- If truly nothing concrete changed (pure talk or observation), return {"ops":[]}.
- The player character's id is "<PC_ID>"; the world flags entity id is "world-state".

GROUNDING BACKSTOP — "actors": if the narration NAMED an interactable character or creature
(one the player could fight, talk to, or be threatened by) that is NOT in the Scene below, list it
under "actors" so it becomes a real entity: [{"name":"<as named>","hostile":true|false,"archetype":"<closest archetype if obvious>"}].
This should be RARE — the scene already contains everyone. Do NOT list ambient scenery, crowds,
weather, distant sounds, or anyone already present. Only nameable, interactable individuals.

Examples:
- Scene has "**Brass Key** (item-key)"; Narration: "You pry the lockbox open and pocket the brass key inside." → {"ops":[{"op":"take","id":"<PC_ID>","item":{"id":"item-key","name":"Brass Key"}}],"actors":[]}
- Narration: "The blade rakes your arm — a hot line of pain, blood welling." → {"ops":[{"op":"damage","id":"<PC_ID>","amount":5}],"actors":[]}
- Scene lists no one named Mara; Narration: "A scarred raider named Mara steps from the wreck, blade drawn." → {"ops":[],"actors":[{"name":"Mara","hostile":true,"archetype":"drifter"}]}
- Narration: "She studies you warily but says nothing more." → {"ops":[],"actors":[]}

Respond with JSON ONLY: {"ops":[...],"actors":[...]}.`;

// ---- Adjudication result schema (P3) ----

const checkRequestSchema = z.object({
  ability: z.string(),
  skill: z.string().optional(),
  dc: z.number().min(1).max(50),
  reason: z.string().optional(),
});

// Permissive on purpose: a real LLM's JSON shape varies (extra fields, a string
// where we expect an object, dc out of range, a check missing `ability`). A strict
// schema here makes structured() THROW, which drops the WHOLE ruling — silently
// losing movement and checks. So we accept anything and coerce in adjudicate().
const adjudicationSchema = z.object({
  speakTo: z.any().optional(),
  note: z.any().optional(),
  move: z.any().optional(),
  checks: z.any().optional(),
  ops: z.any().optional(),
  spawns: z.any().optional(),     // D2: world-first actor staging
  beginCombat: z.any().optional(),// D2/D4: DM-initiated combat
}).passthrough();

// ---- Canonize result schema (P3.1) ----

const canonizeSchema = z.object({
  ops: z.array(z.any()).default([]),
  // D3 grounding backstop: interactable actors the prose NAMED that are not in the
  // scene. Each becomes a real entity so no pure-text actor survives a turn.
  actors: z.array(z.any()).default([]),
});

// ---- Stream counter (shared across agents) ----

let streamCounter = 0;

/**
 * Create the DM agent.
 *
 * @param {object} params
 * @param {import('../session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm — LlmClient
 * @returns {{adjudicate, narrateOutcome, canonize, adjudicateCombat}}
 */
export function createDmAgent({ session, broadcast, applyAndBroadcast, llm, rulesetPrompt, actorTemplates, defaultCheck }) {
  // The DM narration voice comes from the loaded ruleset (P7) when present,
  // else the built-in 5e default. Rules-as-data: the engine names no ruleset.
  const systemPrompt = rulesetPrompt || DM_SYSTEM_PROMPT;
  const sessionId = process.env.TTRPG_SAVE || 'default';
  // How the DM asks for dice: the ruleset's default check kind + DC guidance,
  // else the built-in 5e ability-check. Keeps the adjudicator rules-agnostic.
  const checkSpec = defaultCheck && defaultCheck.kind
    ? { kind: defaultCheck.kind, dcDoc: defaultCheck.dcDoc || 'a difficulty appropriate to the ruleset', shape: defaultCheck.shape || `{check:"${defaultCheck.kind}", dc, reason}` }
    : { kind: 'ability-check', dcDoc: 'DC 5–30 (10 easy, 15 moderate, 20 hard)', shape: '{ability, skill?, dc, reason}' };
  // Archetypes the DM may spawn (world-first). Empty when the ruleset ships no
  // actorTemplates → the DM keeps no spawn power (5e/DSA unaffected).
  const spawnArchetypes = actorTemplates
    ? Object.keys(actorTemplates).filter((k) => k !== '_default')
    : [];

  /**
   * Adjudicate: structured LLM call to decide routing, checks, and consequences.
   * The LLM NEVER supplies dice values — it only REQUESTS checks.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {Array} presentNpcs — from sense.presentAgents()
   * @returns {Promise<{speakTo:string|null, note:string, checks:object[], ops:object[]}>}
   */
  async function adjudicate(actionOp, presentNpcs, lookText) {
    const actionText = actionOp.text || '';

    // Build adjudication context
    const npcList = presentNpcs.map(n => {
      const pers = n.persona ? ` — ${n.persona}` : '';
      return `- ${n.name} (id: "${n.npcId}")${pers}`;
    }).join('\n');

    // The ACTING PC (multiplayer: resolved from the action's sender)
    const pcEntry = findPcFor(session.entities, actionOp.by);
    const pcId = pcEntry ? pcEntry[0] : null;
    const pcStats = pcEntry && pcEntry[1].stats ? JSON.stringify(pcEntry[1].stats) : '{}';
    const pcName = (pcEntry && pcEntry[1].identity && pcEntry[1].identity.name) || 'the hero';

    // Location-scoped scene frame (lists present NPCs/items + exits the player may use).
    const look = lookText || senseLook(session);

    const stageField = spawnArchetypes.length
      ? ', "spawns":[{archetype,name?,hostile?,ally?,count?}], "beginCombat":<true if this starts a fight>'
      : '';
    const messages = [
      {
        role: 'system',
        content: adjudicatePrompt(spawnArchetypes)(npcList, pcId, pcName, pcStats, look),
      },
      {
        role: 'user',
        content: `Player action: "${actionText}"\n\nRespond with JSON ONLY: {"speakTo":<npcId|null>, "move":{"to":"<locationId>"}|null, "note":"<director note for NPC if speaking>", "checks":[${checkSpec.shape}], "ops":[<semantic ops for SUCCESS case>]${stageField}}\nFor "dc" use ${checkSpec.dcDoc}.`,
      },
    ];

    try {
      const { parsed } = await llm.structured(messages, adjudicationSchema, {
        user: sessionId,
        role: 'adjudicate',
      });

      // Coerce every field here so a slightly-off shape never silently drops the ruling.
      const ruling = { speakTo: null, move: null, note: '', checks: [], ops: [], spawns: [], beginCombat: false };

      // speakTo → a present agent-NPC id, else null
      if (typeof parsed.speakTo === 'string' && parsed.speakTo.trim()) {
        const id = parsed.speakTo.trim();
        if (presentNpcs.some(n => n.npcId === id)) ruling.speakTo = id;
        else console.warn(`[dm-agent] Adjudicate speakTo=${id} is not a present agent-NPC; ignoring.`);
      }

      // move → {to:string} (accept a bare string or {to}); connectivity is checked downstream
      if (parsed.move) {
        if (typeof parsed.move === 'string' && parsed.move.trim()) {
          ruling.move = { to: parsed.move.trim() };
        } else if (typeof parsed.move === 'object' && typeof parsed.move.to === 'string' && parsed.move.to.trim()) {
          ruling.move = { to: parsed.move.to.trim() };
        }
      }

      if (typeof parsed.note === 'string') ruling.note = parsed.note;
      if (Array.isArray(parsed.ops)) ruling.ops = parsed.ops;

      // D2: spawns[] — only honored when the ruleset grants spawn power. Each entry is
      // expanded count× and normalized; malformed entries are dropped, never thrown.
      if (spawnArchetypes.length && Array.isArray(parsed.spawns)) {
        const out = [];
        for (const s of parsed.spawns) {
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
        ruling.spawns = out;
      }
      ruling.beginCombat = parsed.beginCombat === true;

      // checks → clamped, defaulted check requests (drops malformed entries, never throws)
      const rawChecks = Array.isArray(parsed.checks) ? parsed.checks : [];
      ruling.checks = rawChecks
        .filter(c => c && typeof c === 'object')
        .map(c => {
          let dc = Number(c.dc);
          if (!Number.isFinite(dc)) dc = 12;
          dc = Math.max(1, Math.min(50, Math.round(dc)));
          return {
            ability: String(c.ability || 'wis').toLowerCase(),
            skill: c.skill ? String(c.skill) : undefined,
            dc,
            reason: c.reason ? String(c.reason) : '',
          };
        });

      return ruling;
    } catch (err) {
      console.error('[dm-agent] Adjudication call failed:', err.message);
      // Fallback: treat as pure narration
      return { speakTo: null, move: null, note: '', checks: [], ops: [] };
    }
  }

  /**
   * Narrate an action outcome incorporating resolved check results.
   * Streams narration, returns the full text.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {object[]} checkResults — resolved check results from checks.js
   * @param {string} lookText — cached scene look frame
   * @returns {Promise<string>}
   */
  async function narrateOutcome(actionOp, checkResults, lookText) {
    const actionText = actionOp.text || '';

    // Build context with check results injected
    const { recentHistory } = await import('../../shared/context.js');
    const history = recentHistory(session.journal, 12);

    // Format check results for the DM
    let checkText = '';
    if (checkResults && checkResults.length > 0) {
      checkText = '\n\n## Resolved checks (ALREADY ROLLED — incorporate into narration):\n';
      for (const r of checkResults) {
        checkText += `- ${r.summary}\n`;
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'system', content: (lookText || '(scene unknown)') + checkText + '\n\nNarrate the outcome of the player\'s action, incorporating the check results above. Do NOT roll dice or reference rules — the dice are already rolled. Describe what HAPPENS in the fiction.\n\nGROUNDING (critical): the scene above is the WHOLE cast. You may ONLY name NPCs, creatures, and objects that are listed there — any threat the moment needed has ALREADY been spawned and appears in the scene. Do NOT introduce a new named character or creature that is not listed; describe the present ones. Ambient scenery (weather, distant noise, unnamed crowds) is fine. A [Name] prefix on the action tells you WHICH party member acts — address them.' },
      { role: 'user', content: (actionOp.by && actionOp.by !== 'player' ? `[${actionOp.by}] ` : '') + actionText },
    ];

    const streamId = `narr-${++streamCounter}`;

    return streamBeat({
      llm,
      messages,
      eventName: 'narration',
      baseData: { by: 'dm' },
      broadcast,
      applyAndBroadcast,
      role: 'dm',
      streamId,
    });
  }

  /**
   * Canonize: distill the state changes the just-delivered narration ESTABLISHED into ops.
   * "Narrate freely, canonize second" — keeps story and state in sync. The narration is
   * already outcome-aware, so the recorded consequences match what the player was told.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {string} narrationText — the narration just streamed to the player
   * @param {object[]} checkResults — resolved check results (for context)
   * @returns {Promise<{ops:object[], actors:object[]}>} — incidental ops + ungrounded actors
   */
  async function canonize(actionOp, narrationText, checkResults) {
    const actionText = actionOp.text || '';
    const pcEntry = findPcFor(session.entities, actionOp.by);
    const pcId = pcEntry ? pcEntry[0] : 'pc-hero';

    let checkText = '';
    if (checkResults && checkResults.length > 0) {
      checkText = '\nDice results: ' + checkResults.map(r => r.summary).join('; ');
    }

    // Ground canonize in the scoped scene so it can reference real item entity ids.
    const lookText = senseLook(session, pcEntry ? pcEntry[0] : undefined);

    const messages = [
      { role: 'system', content: CANONIZE_SYSTEM_PROMPT.replaceAll('<PC_ID>', pcId) },
      {
        role: 'user',
        content: `Scene (the entities that exist HERE — use these exact ids):\n${lookText}\n\nPlayer action: "${actionText}"${checkText}\n\nNarration just delivered to the player:\n"""\n${narrationText}\n"""\n\nOutput JSON {"ops":[...],"actors":[...]} capturing the concrete state changes this narration established AND any interactable actor it named that is not in the Scene. If nothing concrete changed and no new actor was named, return {"ops":[],"actors":[]}.`,
      },
    ];

    try {
      const { parsed } = await llm.structured(messages, canonizeSchema, {
        user: sessionId,
        role: 'canonize',
      });
      return {
        ops: Array.isArray(parsed.ops) ? parsed.ops : [],
        actors: Array.isArray(parsed.actors) ? parsed.actors : [],
      };
    } catch (err) {
      console.error('[dm-agent] Canonize failed:', err.message);
      return { ops: [], actors: [] };
    }
  }

  /**
   * C3: adjudicate an IMPROVISED combat action (off the Move menu). Combat-aware
   * variant of adjudicate — returns {checks, ops} only (no movement/speakTo). The
   * engine rolls the checks and applies the ops on success.
   *
   * @param {object} actionOp — {op:'action', text}
   * @param {string[]} enemyIds — living enemy ids the action may target
   * @returns {Promise<{checks:object[], ops:object[]}>}
   */
  async function adjudicateCombat(actionOp, enemyIds) {
    const actionText = actionOp.text || '';
    const pcEntry = findPcFor(session.entities, actionOp.by);
    const pcId = pcEntry ? pcEntry[0] : 'pc-hero';

    // C4 zone context: list the zones (+ tags) and where each combatant stands, so the
    // adjudicator can place a hazard or exploit a 'ledge'.
    const enc = (session.entities.get('encounter') || {}).encounter || {};
    const zoneOf = (id) => ((session.entities.get(id) || {}).position || {}).zoneId || 'field';
    const zoneList = (enc.zones || []).map(z => `${z.id}${(z.tags || []).length ? ` [${z.tags.join(',')}]` : ''}`).join(', ') || 'field';
    const positions = [pcId, ...(enemyIds || [])].map(id => `${id}@${zoneOf(id)}`).join(', ');

    const messages = [
      { role: 'system', content: `${COMBAT_ADJUDICATE_PROMPT}\n\nThe check kind is "${checkSpec.kind}"; for "dc" use ${checkSpec.dcDoc}.\nLiving enemies: ${(enemyIds || []).join(', ') || '(none)'}\nThe PC id is "${pcId}".\nZones: ${zoneList}\nPositions: ${positions}` },
      { role: 'user', content: `Improvised combat action: "${actionText}"\n\nRespond JSON ONLY: {"checks":[${checkSpec.shape}], "ops":[<applyStatus/damage/spawnHazard for the SUCCESS case>]}` },
    ];

    try {
      const { parsed } = await llm.structured(messages, adjudicationSchema, { user: sessionId, role: 'combat-adjudicate' });
      return {
        checks: Array.isArray(parsed.checks) ? parsed.checks : [],
        ops: Array.isArray(parsed.ops) ? parsed.ops : [],
      };
    } catch (err) {
      console.error('[dm-agent] Combat adjudication failed:', err.message);
      return { checks: [], ops: [] };
    }
  }

  return { adjudicate, narrateOutcome, canonize, adjudicateCombat };
}

/** Build the adjudicate system prompt with dynamic scene/PC info injected. */
function adjudicatePrompt(archetypes) {
  const base = ADJUDICATE_SYSTEM_PROMPT;
  // World-first staging: the DM may only narrate creatures it has SPAWNED. This
  // block is added only when the ruleset ships actorTemplates (else no spawn power).
  const stage = (archetypes && archetypes.length)
    ? `\n\n## STAGE THE WORLD BEFORE YOU NARRATE (critical)
Narration is a VIEW of the world — it can never invent. If your outcome involves any
NPC, creature, or threat that is NOT already listed in the Scene, you MUST stage it now
so it becomes a real entity before it is described:
- "spawns": [{ "archetype": <one of: ${archetypes.join(', ')}>, "name"?: "<specific name>",
  "hostile"?: true, "ally"?: true, "count"?: <n, default 1> }]
  The ENGINE supplies its stats/dice — you only pick the archetype and intent.
- To START A FIGHT, set "beginCombat": true AND spawn the hostiles in "spawns".
NEVER mention a character in narration that you did not spawn or that isn't in the Scene.`
    : '';
  return (npcList, pcId, pcName, pcStats, lookText) =>
    base + stage + `\n\n## Scene (only these entities exist HERE)\n${lookText || '(scene unknown)'}\n\nNPCs you may route to:\n${npcList || '(none)'}\n\n## The PC\nID: "${pcId || 'unknown'}"\nName: ${pcName}\nStats: ${pcStats}\nWorld-state id: "world-state"`;
}
