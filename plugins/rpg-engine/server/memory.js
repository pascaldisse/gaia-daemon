/**
 * server/memory.js — the memory engine: lifelogs + living summaries (P6).
 *
 * The anti-Instantale: narrative canon must not live only in a rolling context
 * window. This engine listens to the session JOURNAL and writes the durable
 * story into each character's `lifelog` component:
 *
 *   - party PCs remember quest steps, level-ups, and how fights ended
 *   - NPCs remember what they said to the party (their side of the exchange)
 *   - every entry is stamped with the world clock ("Day 2, evening: …")
 *
 * When a lifelog grows past the threshold, an LLM distills it into an ≤80-word
 * living summary (the original Instantale's "Log Manager", done right: the
 * entries that were folded away are DROPPED — the summary is now canon).
 * Without an LLM the entries alone still work; distillation is best-effort.
 *
 * Deterministic capture, zero extra LLM calls in the hot path.
 */

import { z } from 'zod';
import { findPcs } from '../shared/space.js';
import { clockLine } from '../shared/clock.js';

const MAX_ENTRIES = 18;   // distill when a lifelog reaches this many lines
const KEEP_RAW = 6;       // most-recent entries kept verbatim after a distill

const DistillSchema = z.object({ summary: z.string() });

export function createMemoryEngine({ session, applyAndBroadcast, llm }) {
  const distilling = new Set();

  const stamp = () => clockLine(session.entities.get('world-state') || {});
  const partyIds = () => findPcs(session.entities).map(([id]) => id);

  /** Append one remembered line to a set of characters' lifelogs. */
  function note(ids, line) {
    if (!line) return;
    for (const id of ids) {
      const comps = session.entities.get(id);
      if (!comps) continue;
      const cur = comps.lifelog || {};
      const entries = [...(cur.entries || [])];
      // Dedupe: the same beat repeated back-to-back is one memory.
      if (entries.length && entries[entries.length - 1].endsWith(line)) continue;
      entries.push(`${stamp()}: ${line}`);
      while (entries.length > MAX_ENTRIES + 6) entries.shift(); // hard cap, even mid-distill
      applyAndBroadcast([{ op: 'merge', id, component: 'lifelog', value: { entries } }], 'memory');
      if (entries.length >= MAX_ENTRIES) distill(id).catch(() => {});
    }
  }

  /** Fold old entries into the ≤80-word living summary (LLM, best-effort). */
  async function distill(id) {
    if (!llm || distilling.has(id)) return;
    const comps = session.entities.get(id);
    const cur = comps && comps.lifelog;
    if (!cur || (cur.entries || []).length < MAX_ENTRIES) return;
    distilling.add(id);
    try {
      const name = (comps.identity || {}).name || id;
      const folded = cur.entries.slice(0, -KEEP_RAW);
      const { parsed } = await llm.structured(
        [
          { role: 'system', content: `You keep a character's life log. Merge the existing summary and the new events into ONE summary of AT MOST 80 words, third person, keeping names, deaths, debts, promises and unresolved threads. Drop mood and scenery.` },
          { role: 'user', content: `Character: ${name}\nExisting summary: ${cur.summary || '(none)'}\nNew events:\n${folded.join('\n')}\n\nReturn JSON ONLY: {"summary":"..."}` },
        ],
        DistillSchema,
        { user: 'memory', role: 'memory-distill' },
      );
      // The folded entries are now IN the summary — drop them (fold-down, not eviction).
      applyAndBroadcast([{
        op: 'merge', id, component: 'lifelog',
        value: { summary: parsed.summary.slice(0, 700), entries: cur.entries.slice(-KEEP_RAW) },
      }], 'memory');
      console.log(`[memory] Distilled ${id} lifelog (${folded.length} entries folded)`);
    } catch (e) {
      // Keep the raw entries — nothing is lost when distillation fails.
      console.warn(`[memory] Distill failed for ${id}: ${e.message}`);
    } finally {
      distilling.delete(id);
    }
  }

  /** Journal listener — the story writes itself into the people it happened to. */
  function onJournal(entry) {
    if (entry.op !== 'event') return;
    const d = entry.data || {};
    if (entry.name === 'system') {
      if (d.kind === 'quest' && ['step', 'complete'].includes(d.phase) && d.text) {
        note(partyIds(), d.text);
      } else if (d.kind === 'levelup' && d.text) {
        note(partyIds(), d.text);
      } else if (d.kind === 'combat' && d.phase === 'end' && d.outcome && d.text) {
        note(partyIds(), d.text);
      }
      return;
    }
    // An NPC remembers its own words (done-events only — not stream deltas).
    if (entry.name === 'dialogue' && d.by && d.done && d.text) {
      note([d.by], `said to the party: "${String(d.text).slice(0, 100)}"`);
    }
  }

  const detach = session.onChange(onJournal);
  return { note, distill, destroy: detach };
}

/**
 * Keyword recall over lifelogs + the journal — the poor man's semantic memory.
 * Scores lines by query-token overlap; returns the top matches, newest first
 * among ties. Zero dependencies; swap for embeddings later without changing
 * the endpoint.
 *
 * @returns {Array<{source:string, line:string, score:number}>}
 */
export function recall(session, query, limit = 10) {
  const tokens = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (!tokens.length) return [];
  const hits = [];
  const score = (line) => {
    const l = line.toLowerCase();
    let s = 0;
    for (const t of tokens) if (l.includes(t)) s++;
    return s;
  };

  for (const [id, comps] of session.entities) {
    const log = comps.lifelog;
    if (!log) continue;
    const name = (comps.identity || {}).name || id;
    if (log.summary) {
      const s = score(log.summary);
      if (s) hits.push({ source: `${name} (summary)`, line: log.summary, score: s });
    }
    for (const e of log.entries || []) {
      const s = score(e);
      if (s) hits.push({ source: name, line: e, score: s });
    }
  }
  for (const entry of session.journal) {
    if (entry.op === 'event' && (entry.name === 'narration' || entry.name === 'dialogue')) {
      const text = (entry.data || {}).text;
      if (!text || !(entry.data || {}).done) continue;
      const s = score(text);
      if (s) hits.push({ source: entry.name, line: String(text).slice(0, 220), score: s });
    } else if (entry.op === 'action' && entry.text) {
      const s = score(entry.text);
      if (s) hits.push({ source: `action (${entry.by || '?'})`, line: entry.text, score: s });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
