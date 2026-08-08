/**
 * shared/context.js — prompt construction for LLM turn engine.
 *
 * PURE — no imports from server/ or client/.
 *
 * EXTENSION SEAM: when rulesets are loaded (P6), the system prompt prefix
 * will be extended from ruleset data (ruleset/system-prompt.txt + schema).
 */

import { findPc, findPcs, pcLocationId, entitiesAt, exitsFrom } from './space.js';


/**
 * Build a compact text "scene frame" from the entity store — LOCATION-SCOPED.
 *
 * This is the single, canonical scene-frame generator (server/sense.js `look()`
 * delegates here). It shows ONLY what is present at the acting PC's current
 * location: the location itself + its exits, the NPCs and ground items HERE,
 * the party members HERE, plus globally-relevant active quests and world flags.
 * "Only what's HERE is present" — the whole world is never dumped into context.
 *
 * @param {Map<string,object>|Record<string,object>} entities
 * @param {string} [pcId] — the acting PC to scope around (default: first PC)
 * @returns {string}
 */
export function buildLookFrame(entities, pcId) {
  const map = entities instanceof Map ? entities : new Map(Object.entries(entities));
  if (map.size === 0) {
    return 'Current scene: (empty — no entities loaded).';
  }

  const pc = pcId && map.get(pcId) ? [pcId, map.get(pcId)] : findPc(map);
  const locId = pcLocationId(map, pc ? pc[0] : undefined);
  const locComps = locId ? map.get(locId) : null;
  const parts = ['Current scene frame:'];

  // ---- Current location (only) + its exits ----
  if (locComps) {
    const li = locComps.identity || {};
    parts.push('\nLocation:');
    parts.push(`- **${li.name || locId}** (${locId}): ${li.description || ''}`);
    const exits = exitsFrom(map, locId).filter(e => e.exists);
    if (exits.length > 0) {
      parts.push('Exits (where you can go from here):');
      for (const e of exits) {
        const tName = ((map.get(e.targetId) || {}).identity || {}).name || e.targetId;
        parts.push(`- ${e.label} → ${tName} (${e.targetId})`);
      }
    }
  } else {
    parts.push('\nLocation: (unknown — the party is nowhere in particular).');
  }

  // ---- NPCs physically present HERE ----
  const npcs = locId ? entitiesAt(map, locId, { kinds: ['npc'] }) : [];
  if (npcs.length > 0) {
    parts.push('\nNPCs present:');
    for (const [id, comps] of npcs) {
      const idn = comps.identity || {};
      const desc = idn.description ? ` — ${idn.description}` : '';
      const pers = (comps.persona || {}).personality ? ` Personality: ${comps.persona.personality}.` : '';
      const agentTag = (comps.agent || {}).enabled ? ' [AGENT]' : '';
      parts.push(`- **${idn.name || id}** (${id})${agentTag}${desc}${pers}`);
    }
  }

  // ---- Ground items HERE (carried items have place.locationId === holder, so excluded) ----
  const items = locId ? entitiesAt(map, locId, { kinds: ['item'] }) : [];
  if (items.length > 0) {
    parts.push('\nItems here:');
    for (const [id, comps] of items) {
      const idn = comps.identity || {};
      const desc = idn.description ? ` — ${idn.description}` : '';
      parts.push(`- **${idn.name || id}** (${id})${desc}`);
    }
  }

  // ---- Party (every PC at this location; the acting PC marked) ----
  const party = findPcs(map).filter(([id, c]) =>
    !locId || ((c.place || {}).locationId || null) === locId);
  if (party.length > 0) {
    parts.push('\nParty:');
    for (const [id, comps] of party) {
      const idn = comps.identity || {};
      const stats = comps.stats || {};
      const hpStr = stats.hp !== undefined ? ` HP:${stats.hp}/${stats.maxHp}` : '';
      const status = comps.status || {};
      const conds = (status.conditions || []).length > 0
        ? ` Conditions: ${status.conditions.join(', ')}.` : '';
      const inv = (comps.inventory || {}).items || [];
      const carried = inv.length > 0
        ? ` Carrying: ${inv.map(i => {
            const iid = typeof i === 'string' ? i : i.id;
            const iname = typeof i === 'string' ? i : (i.name || i.id);
            return `**${iname}** (${iid})`;
          }).join(', ')}.`
        : ' Carrying: nothing of note.';
      const acting = pc && id === pc[0] ? ' ← ACTING' : '';
      parts.push(`- **${idn.name || id}** (${id})${hpStr}${conds}${carried}${acting}`);
      // P6: the living summary — what this character has been through stays
      // canon even after the rolling window forgets it.
      const log = comps.lifelog || {};
      if (log.summary) parts.push(`  Their story so far: ${log.summary}`);
    }
  }

  // ---- Active quests (global) ----
  const quests = [];
  for (const [id, comps] of map) {
    if ((comps.identity || {}).kind !== 'quest') continue;
    const q = comps.quest || {};
    if (q.phase === 'active' || q.phase === 'available') {
      const steps = q.steps || [];
      const cur = steps[q.currentStep || 0] || '';
      quests.push(`- **${(comps.identity || {}).name || id}** (${id}) [${q.phase}] ${cur}`);
    }
  }
  if (quests.length > 0) {
    parts.push('\nActive quests:');
    parts.push(...quests);
  }

  // ---- World flags (global; canonical entity id 'world-state') ----
  const ws = map.get('world-state');
  if (ws && ws.flags && Object.keys(ws.flags).length > 0) {
    parts.push('\nWorld flags:');
    for (const [k, v] of Object.entries(ws.flags)) {
      parts.push(`- ${k}: ${JSON.stringify(v)}`);
    }
  }

  return parts.join('\n');
}

/**
 * Extract the last n journal entries relevant for LLM context.
 * Maps action→user, narration/dialogue(done)→assistant.
 * Dialogue entries are prefixed with the speaker name.
 *
 * @param {Array<{op:string,name?:string,text?:string,data?:object}>} journalEntries
 * @param {number} [n=12] — max entries to return
 * @returns {Array<{role:string, content:string}>}
 */
export function recentHistory(journalEntries, n = 12) {
  if (!Array.isArray(journalEntries)) return [];

  const relevant = [];
  // Walk from end, collect action + done-narration + done-dialogue entries
  for (let i = journalEntries.length - 1; i >= 0 && relevant.length < n; i--) {
    const entry = journalEntries[i];

    if (entry.op === 'action' && entry.text) {
      // Multiplayer: attribute the action so the DM knows WHO did it.
      const by = entry.by && entry.by !== 'player' ? `[${entry.by}] ` : '';
      relevant.unshift({ role: 'user', content: `${by}${entry.text}` });
    } else if (entry.op === 'event' && entry.name === 'narration') {
      const data = entry.data || {};
      if (data.done && data.text) {
        relevant.unshift({ role: 'assistant', content: data.text });
      }
    } else if (entry.op === 'event' && entry.name === 'dialogue') {
      const data = entry.data || {};
      if (data.done && data.text) {
        const speakerName = data.name || data.speaker || 'NPC';
        relevant.unshift({ role: 'assistant', content: `${speakerName}: ${data.text}` });
      }
    }
  }

  return relevant;
}

/**
 * Extract the last n beats that a specific NPC witnessed.
 * For P2: all narration/dialogue/action in the current scene.
 * Returns chat-message array for the NPC's context.
 *
 * @param {Array<{op:string,name?:string,text?:string,data?:object}>} journalEntries
 * @param {string} npcId
 * @param {number} [n=12]
 * @returns {Array<{role:string, content:string}>}
 */
export function npcMemoryFor(journalEntries, npcId, n = 12) {
  if (!Array.isArray(journalEntries)) return [];

  // For P2: return all recent beats (the NPC is present and witnesses everything)
  // Future: filter by location/scene scope
  return recentHistory(journalEntries, n);
}

/**
 * Build context messages for an NPC agent's response.
 * Cache-ordered: stable prefix first, dynamic scene+input last.
 *
 * @param {object} params
 * @param {object} params.npc            — {id, name, personality, backstory, voice, knowledge, systemPrompt?}
 * @param {string} params.look           — the scene frame text (from sense.look)
 * @param {string} params.playerText     — what the player said
 * @param {Array}  params.npcMemory      — NPC's recent witnessed beats [{role,content}]
 * @param {string} [params.directorNote] — optional DM stage direction
 * @returns {Array<{role:string, content:string}>}
 */
export function buildNpcContext({ npc, look, playerText, npcMemory, directorNote }) {
  const messages = [];

  // 1. SYSTEM: stable prefix — NPC identity + private knowledge (byte-stable → cache hit)
  const derivedPrompt = npc.systemPrompt || deriveNpcSystemPrompt(npc);
  const knowledgeBlock = formatKnowledge(npc.knowledge);
  messages.push({
    role: 'system',
    content: derivedPrompt + (knowledgeBlock ? '\n\n' + knowledgeBlock : ''),
  });

  // 1.5 P6: the NPC's own lifelog — durable memory that outlives the window.
  const log = npc.lifelog || {};
  const remembered = [
    log.summary ? `What you remember of your story so far: ${log.summary}` : '',
    (log.entries || []).length ? `Recently: ${log.entries.slice(-4).join(' | ')}` : '',
  ].filter(Boolean).join('\n');
  if (remembered) messages.push({ role: 'system', content: remembered });

  // 2. NPC memory — recent witnessed beats as history
  messages.push(...(npcMemory || []));

  // 3. SYSTEM: the shared look frame (current scene — changes but placed late)
  messages.push({ role: 'system', content: look || 'Current scene: (none).' });

  // 4. (optional) SYSTEM: director-note — clearly marked OOC stage direction
  if (directorNote && directorNote.trim()) {
    messages.push({
      role: 'system',
      content: `[STAGE DIRECTION from the DM — use this to guide your response, but do NOT quote it directly]\n${directorNote.trim()}`,
    });
  }

  // 5. USER: the player's words addressed to the NPC
  messages.push({ role: 'user', content: playerText || '' });

  return messages;
}

/**
 * Derive system prompt for an NPC from its persona.
 *
 * @param {object} npc — {name, personality, backstory, voice}
 * @returns {string}
 */
function deriveNpcSystemPrompt(npc) {
  const name = npc.name || 'the character';
  const personality = npc.personality || '';
  const backstory = npc.backstory || '';
  const voice = npc.voice || '';

  let prompt = `You are ${name}. Speak ONLY as yourself, in first-person, in-character.\n`;
  prompt += `You know ONLY what follows; never invent or reveal knowledge you don't have.\n`;
  prompt += `Keep responses short — 1 to 3 sentences, like natural dialogue.\n`;

  if (personality) prompt += `\nPersonality: ${personality}`;
  if (backstory) prompt += `\nBackstory: ${backstory}`;
  if (voice) prompt += `\nVoice: ${voice}`;

  return prompt;
}

/**
 * Format knowledge component for inclusion in NPC system prompt.
 *
 * @param {{facts:string[], secrets:string[]}} knowledge
 * @returns {string}
 */
function formatKnowledge(knowledge) {
  if (!knowledge) return '';
  const parts = [];

  if (knowledge.facts && knowledge.facts.length > 0) {
    parts.push('## Things you know (public):');
    for (const f of knowledge.facts) {
      parts.push(`- ${f}`);
    }
  }

  if (knowledge.secrets && knowledge.secrets.length > 0) {
    parts.push('\n## Things you know but guard (secrets):');
    for (const s of knowledge.secrets) {
      parts.push(`- ${s}`);
    }
  }

  return parts.join('\n');
}
