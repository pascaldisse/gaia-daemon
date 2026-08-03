/**
 * server/session.js — Session class.
 * Owns the canonical entity store (Map<id, components>), journal, and counter.
 * Handles op application, save/load, seed from campaign files.
 *
 * Based on GAIA's world.js pattern.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyOp, isCanonOp } from '../shared/ops.js';
import { makeRng } from '../shared/rng.js';
import { backfillTiles } from '../shared/tilegen.js';

const JOURNAL_CAP = 2000;
const SAVE_VERSION = 1;

export class Session {
  entities = new Map();       // id → { componentName: value }
  counter = 0;               // auto-increment entity id counter
  journal = [];              // [{seq, t, from, ...op}]
  listeners = new Set();     // callbacks called with (journalEntry) after each op
  _seq = 0;
  _savePath = null;
  _saveTimer = null;
  _seedDir = null;
  seed = 42;                 // PRNG seed (default 42; loaded from save)
  rollCount = 0;             // incremented per roll (ensures distinct rolls)

  /**
   * @param {string} seedDir — path to world/ (campaign directory)
   * @param {string} saveSlot — TTRPG_SAVE env value (default "default")
   */
  constructor(seedDir, saveSlot = 'default') {
    this._seedDir = seedDir;
    const savesDir = path.join(seedDir, 'saves');
    if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });
    this._savePath = path.join(savesDir, `session_${saveSlot}.json`);

    // Optional deterministic PRNG seed override (reproducible sessions / tests / sharing).
    // A loaded save still wins (load() may set its own seed); applies to fresh sessions.
    const envSeed = parseInt(process.env.TTRPG_SEED, 10);
    if (Number.isFinite(envSeed)) this.seed = envSeed;
  }

  // ---- Listeners ----

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(entry) {
    for (const fn of this.listeners) {
      try { fn(entry); } catch (_) { /* ignore listener errors */ }
    }
  }

  // ---- Snapshot ----

  /**
   * Return a fresh deterministic RNG for the next roll.
   * Uses seed + rollCount so each roll is distinct and reproducible.
   * @returns {{d:(sides:number)=>number, int:(min:number,max:number)=>number, next:()=>number}}
   */
  rng() {
    const r = makeRng(this.seed + this.rollCount);
    this.rollCount++;
    return r;
  }

  snapshot() {
    const entities = {};
    for (const [id, comps] of this.entities) {
      entities[id] = JSON.parse(JSON.stringify(comps));
    }
    return {
      type: 'snapshot',
      time: Date.now(),
      counter: this.counter,
      entities,
      world: this._seedDir,
      ruleset: null, // P1+
    };
  }

  // ---- Events / journal ----

  /** Return journal entries since seq (exclusive), up to limit. */
  eventsSince(seq, limit = 200) {
    const start = this.journal.findIndex(e => e.seq > seq);
    if (start === -1) return { latest: this._seq, events: [] };
    const events = this.journal.slice(start, start + limit);
    return { latest: this._seq, events };
  }

  // ---- Apply ops ----

  /**
   * Apply a batch of ops.
   * @param {object[]} ops
   * @param {string} from — who sent the ops
   * @param {number} [t] — timestamp (default Date.now())
   * @returns {{ok:boolean, applied:object[], error?:string}}
   */
  applyOps(ops, from, t = Date.now()) {
    const counterRef = { value: this.counter };
    const applied = [];
    const broadcast = [];   // full ops (with payload) to send to clients
    let resnapshot = false; // set true after a reset → server re-sends a snapshot

    for (const op of ops) {
      // Reset re-seeds from disk; handled here and surfaced via a fresh snapshot.
      if (op.op === 'reset') {
        this.reset(op.scene || null);
        resnapshot = true;
        applied.push({ ...op });
        continue;
      }

      const result = applyOp(this.entities, op, counterRef);
      if (!result.ok) {
        return { ok: false, error: result.error, applied, broadcast, resnapshot };
      }
      this.counter = counterRef.value;

      this._journal(op, from, t, result);

      // Broadcast the FULL op so clients can reconcile — never the compact journal entry.
      if (result.broadcast) {
        if (op.op === 'spawn') {
          broadcast.push({ op: 'spawn', id: result.id, components: op.components || {} });
        } else {
          broadcast.push(op);
        }
      }

      applied.push({ ...op, _result: result });
    }

    if (applied.some(a => isCanonOp(a))) this._debounceSave();

    return { ok: true, applied, broadcast, resnapshot };
  }

  /**
   * Append a journal entry = op + {seq,t,from}. Carries the full op payload
   * (components/value/data) so /events can replay state — GAIA's journal model.
   */
  _journal(op, from, t, result) {
    const full = { ...op };
    if (op.op === 'spawn' && !full.id && result && result.id) full.id = result.id;
    const entry = { seq: ++this._seq, t, from, ...full };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) {
      this.journal = this.journal.slice(-JOURNAL_CAP);
    }
    this._notify(entry);
    return entry;
  }

  // ---- Seed from world directory ----

  /** Load campaign.json + scenes/*.json into entities. */
  seedFromWorld(dir) {
    this._seedDir = dir;
    this.entities.clear();
    this.counter = 0;

    // Load campaign.json (superscene — just validate existence for P0)
    const campaignPath = path.join(dir, 'campaign.json');
    let campaign = {};
    if (fs.existsSync(campaignPath)) {
      campaign = JSON.parse(fs.readFileSync(campaignPath, 'utf-8'));
    }

    // Load all scene files
    const scenesDir = path.join(dir, 'scenes');
    if (fs.existsSync(scenesDir)) {
      for (const file of fs.readdirSync(scenesDir)) {
        if (!file.endsWith('.json')) continue;
        const sceneData = JSON.parse(fs.readFileSync(path.join(scenesDir, file), 'utf-8'));
        for (const [id, comps] of Object.entries(sceneData)) {
          this.entities.set(id, JSON.parse(JSON.stringify(comps)));
          // Track counter from numeric ids like "e42"
          const match = id.match(/^e(\d+)$/);
          if (match) {
            const n = parseInt(match[1], 10);
            if (n > this.counter) this.counter = n;
          }
        }
      }
    }

    // Walkable-world backfill: any location without an authored tile grid gets a
    // deterministic one (fixed seed: same location id ⇒ same map on every boot,
    // regardless of TTRPG_SEED), BEFORE the fingerprint so tiles are part of the
    // world's identity rather than save noise.
    const filled = backfillTiles(this.entities);
    if (filled) console.log(`[session] Tile maps generated for ${filled} location(s)`);

    // Fingerprint the freshly seeded world so load() can detect a save written
    // against DIFFERENT campaign content (edited scenes shadowed by a stale save).
    const seeded = {};
    for (const [id, comps] of [...this.entities.entries()].sort()) seeded[id] = comps;
    this._worldFingerprint = crypto.createHash('sha1')
      .update(JSON.stringify(seeded)).digest('hex').slice(0, 12);

    return campaign;
  }

  // ---- Reset ----

  /**
   * Reset: re-seed from campaign files, preserving persist/presence entities.
   * @param {string} [scene] — specific scene to reset (null = full reset)
   */
  reset(scene = null) {
    // Collect persist + presence entities
    const preserved = new Map();
    for (const [id, comps] of this.entities) {
      if (comps.persist || comps.presence) {
        preserved.set(id, JSON.parse(JSON.stringify(comps)));
      }
    }

    // Re-seed
    this.seedFromWorld(this._seedDir);

    // Restore preserved
    for (const [id, comps] of preserved) {
      this.entities.set(id, comps);
    }

    // Notify full reset via journal
    const entry = {
      seq: ++this._seq,
      t: Date.now(),
      from: 'system',
      op: 'reset',
      scene: scene || null,
    };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) {
      this.journal = this.journal.slice(-JOURNAL_CAP);
    }
    this._notify(entry);
  }

  // ---- Save / Load ----

  /** Save canon entities to session save file. */
  save() {
    if (!this._savePath) return;
    const data = {
      version: SAVE_VERSION,
      world: this._worldFingerprint || null,
      savedAt: new Date().toISOString(),
      counter: this.counter,
      seed: this.seed,
      rollCount: this.rollCount,
      entities: {},
    };
    for (const [id, comps] of this.entities) {
      data.entities[id] = JSON.parse(JSON.stringify(comps));
    }
    fs.writeFileSync(this._savePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load canon overlay from session save. Overlays on top of seeded entities.
   * A save written against a different save format OR different campaign content
   * is NOT loaded — it is renamed to a .stale-<timestamp> backup and the world
   * boots fresh (an edited campaign would otherwise be shadowed by old state).
   */
  load() {
    if (!this._savePath || !fs.existsSync(this._savePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._savePath, 'utf-8'));

      const versionOk = data.version === SAVE_VERSION;
      const worldOk = !data.world || data.world === this._worldFingerprint;
      if (!versionOk || !worldOk) {
        const backup = this._savePath.replace(/\.json$/, `.stale-${Date.now()}.json`);
        fs.renameSync(this._savePath, backup);
        console.warn(
          `[session] Save ${!versionOk ? `version ${data.version ?? 'none'} ≠ ${SAVE_VERSION}` : 'was written against different campaign content'}` +
          ` — starting fresh (old save backed up to ${path.basename(backup)})`
        );
        return;
      }

      if (data.counter > this.counter) this.counter = data.counter;
      if (data.seed !== undefined) this.seed = data.seed;
      if (data.rollCount !== undefined) this.rollCount = data.rollCount;
      for (const [id, comps] of Object.entries(data.entities || {})) {
        this.entities.set(id, JSON.parse(JSON.stringify(comps)));
      }
      console.log(`[session] Resumed save "${path.basename(this._savePath)}" (${Object.keys(data.entities || {}).length} entities)`);
    } catch (e) {
      console.error('Session load error:', e.message);
    }
  }

  /** Debounced save (300ms). */
  _debounceSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.save();
      this._saveTimer = null;
    }, 300);
  }

  /** Flush any pending save immediately. */
  flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.save();
    }
  }

  /** Flush persistence and detach every journal listener owned by this session. */
  destroy() {
    this.flushSave();
    this.listeners.clear();
  }
}
