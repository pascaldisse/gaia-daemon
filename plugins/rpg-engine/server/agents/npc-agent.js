/**
 * server/agents/npc-agent.js — NPC agent-client.
 *
 * Each NPC is its own agent with its own system prompt, scoped private knowledge,
 * and own memory. Emits event:dialogue in its own voice.
 *
 * The DM routes player input to an NPC agent; the NPC responds in-character.
 */

import { z } from 'zod';
import { buildNpcContext, npcMemoryFor } from '../../shared/context.js';
import { look as senseLook } from '../sense.js';
import { streamBeat } from './stream-beat.js';
import { createDispositionTracker } from '../npcs.js';

// Permissive: a real LLM's combat decision shape varies — coerce in combatDecide().
const combatDecideSchema = z.object({
  intent: z.any().optional(),
  say: z.any().optional(),
  move: z.any().optional(),
  target: z.any().optional(),
}).passthrough();

// ---- Stream counter (module-level, shared with dm-agent) ----

let streamCounter = 0;

/**
 * Create an NPC agent.
 *
 * @param {object} params
 * @param {import('../session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm — LlmClient
 * @returns {{respond: (npcId:string, playerText:string, directorNote?:string) => Promise<string>}}
 */
export function createNpcAgent({ session, broadcast, applyAndBroadcast, llm }) {
  // One disposition tracker per agent, used PURELY for tier mapping. The live
  // disposition value is STORED on the npc entity's 'disposition' component (so it
  // persists with saves and the DM can move it via merge ops) — this tracker only
  // turns a value into its human tier label.
  const tracker = createDispositionTracker();
  // Capture the tracker's default value without mutating it (get() creates no record).
  const DEFAULT_DISPOSITION = tracker.get('__default__');

  /** Read an npc entity's stored disposition value (tracker default if unset). */
  function dispositionValueOf(npcId) {
    const disp = (session.entities.get(npcId) || {}).disposition || {};
    return typeof disp.value === 'number' ? disp.value : DEFAULT_DISPOSITION;
  }

  /** Map a raw disposition value to its tier label via the tracker. */
  function tierOf(npcId, value) {
    tracker.load({ npcs: { [npcId]: { value, history: [] } } });
    return tracker.tier(npcId);
  }

  /**
   * Current disposition of an NPC toward the party.
   * @param {string} npcId
   * @returns {{value:number, tier:string}}
   */
  function dispositionOf(npcId) {
    const value = dispositionValueOf(npcId);
    return { value, tier: tierOf(npcId, value) };
  }

  /**
   * Have an NPC respond to the player in-character.
   *
   * @param {string} npcId — the entity id of the NPC
   * @param {string} playerText — what the player said/asked
   * @param {string} [directorNote] — optional DM stage direction injected into context
   * @returns {Promise<string>} — the NPC's response text
   */
  async function respond(npcId, playerText, directorNote, pcId) {
    // Gather NPC components
    const comps = session.entities.get(npcId);
    if (!comps) {
      // NPC missing — fallback: broadcast a system note
      applyAndBroadcast([{
        op: 'event',
        name: 'system',
        data: {
          text: `[Unknown entity ${npcId}]`,
          done: true,
        },
      }], 'system');
      return '';
    }

    const identity = comps.identity || {};
    const persona = comps.persona || {};
    const knowledge = comps.knowledge || { facts: [], secrets: [] };
    const agent = comps.agent || {};
    const accent = agent.accent || '#4a9eff';

    const npcDef = {
      id: npcId,
      name: identity.name || npcId,
      personality: persona.personality || '',
      backstory: persona.backstory || '',
      voice: persona.voice || '',
      knowledge,
      lifelog: comps.lifelog || {},
      systemPrompt: agent.systemPrompt || null,
    };

    // Build NPC context, scoped to the acting PC's location
    const lookText = senseLook(session, pcId);
    const memory = npcMemoryFor(session.journal, npcId, 12);

    const messages = buildNpcContext({
      npc: npcDef,
      look: lookText,
      playerText,
      npcMemory: memory,
      directorNote: directorNote || null,
    });

    // One-line disposition cue: how this NPC currently feels about the party.
    const { value: dispValue, tier: dispTier } = dispositionOf(npcId);
    messages.splice(Math.max(0, messages.length - 1), 0, {
      role: 'system',
      content: `Your current disposition toward the party: ${dispTier} (${dispValue})`,
    });

    const streamId = `dial-${++streamCounter}`;

    return streamBeat({
      llm,
      messages,
      eventName: 'dialogue',
      baseData: {
        by: npcId,
        speaker: npcId,
        name: identity.name || npcId,
        accent,
      },
      broadcast,
      applyAndBroadcast,
      role: 'npc',
      streamId,
    });
  }

  /**
   * C3: a morale-broken enemy decides what to do this turn (ONE LLM call). Returns a
   * structured intent: 'fight' | 'flee' | 'surrender' | 'parley', with an optional
   * in-voice `say` line. The engine maps the intent to ops (deterministic resolution).
   *
   * @param {string} npcId
   * @param {string} summary — a combat-context summary (its HP, who's winning)
   * @returns {Promise<{intent:string, say:string, move?:any, target?:any}>}
   */
  async function combatDecide(npcId, summary) {
    const comps = session.entities.get(npcId);
    if (!comps) return { intent: 'fight', say: '' };
    const identity = comps.identity || {};
    const persona = comps.persona || {};
    const knowledge = comps.knowledge || { facts: [], secrets: [] };
    const name = identity.name || npcId;

    const system = [
      `You ARE ${name}. You are an individual combatant in a fight that is going BADLY for you.`,
      persona.personality ? `Personality: ${persona.personality}` : '',
      persona.voice ? `Voice: ${persona.voice}` : '',
      (knowledge.secrets || []).length ? `What you privately know/fear: ${(knowledge.secrets || []).join(' ')}` : '',
      `Decide what you do THIS turn. Choose an intent:`,
      `- "fight": keep attacking (you're not broken enough to quit)`,
      `- "flee": break and run from the fight`,
      `- "surrender": throw down and beg for your life`,
      `- "parley": try to talk/deal your way out`,
      `Respond JSON ONLY: {"intent":"fight|flee|surrender|parley","say":"<a SHORT line in your voice, or empty>"}.`,
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: summary || 'You are badly wounded. What do you do?' },
    ];

    try {
      const { parsed } = await llm.structured(messages, combatDecideSchema, {
        user: process.env.TTRPG_SAVE || 'default',
        role: 'combat-decide',
      });
      const intent = ['fight', 'flee', 'surrender', 'parley'].includes(String(parsed.intent))
        ? String(parsed.intent) : 'fight';
      return {
        intent,
        say: typeof parsed.say === 'string' ? parsed.say : '',
        move: parsed.move,
        target: parsed.target,
      };
    } catch (err) {
      console.error('[npc-agent] combatDecide failed:', err.message);
      return { intent: 'fight', say: '' };
    }
  }

  /** Broadcast a one-off in-voice line for an NPC (used for morale beats). */
  function say(npcId, text) {
    if (!text) return;
    const comps = session.entities.get(npcId) || {};
    const identity = comps.identity || {};
    const accent = (comps.agent || {}).accent || '#4a9eff';
    applyAndBroadcast([{
      op: 'event', name: 'dialogue',
      data: { by: npcId, speaker: npcId, name: identity.name || npcId, accent, text, done: true },
    }], 'npc');
  }

  return { respond, combatDecide, say, dispositionOf };
}
