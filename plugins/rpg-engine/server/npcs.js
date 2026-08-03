/**
 * server/npcs.js — NPC disposition tracker (P-ATOM5).
 *
 * PURE — no imports, no I/O, no module-level (global) mutable state. All state
 * lives inside the closure returned by `createDispositionTracker`, so multiple
 * independent trackers never interfere. Wiring this into the live session
 * (persistence, event hooks, prompts) happens in a later wave — this module
 * only holds the rules.
 *
 * A disposition is a clamped score per NPC id. `tiers` maps score ranges to a
 * human name: the tier for a value is the entry with the HIGHEST `minScore`
 * that is still `<= value` (tiers need not be pre-sorted; this is resolved
 * defensively either way).
 *
 * Serialization: `serialize()` returns a plain-JSON snapshot of tracked NPCs
 * only (not `opts` — options belong to whichever tracker you load into).
 * Restoring is the instance method `tracker.load(data)` (NOT a second
 * `hydrate(data, opts)` export — picking one to avoid two ways to do the same
 * thing): create a tracker with the desired opts, then `.load(serialized)` to
 * replace its state. `load` clamps and re-caps history defensively in case the
 * data came from a tracker with different opts.
 */

/**
 * @typedef {[number, string]} Tier — [minScore, name], ascending by minScore.
 * @typedef {{delta:number, reason:(string|null), at:number}} HistoryEntry
 * @typedef {{value:number, history:HistoryEntry[]}} NpcRecord
 */

const DEFAULT_TIERS = [
  [-100, 'hostile'],
  [-40, 'wary'],
  [-10, 'neutral'],
  [25, 'friendly'],
  [70, 'devoted'],
];

/**
 * Create an independent disposition tracker.
 *
 * @param {object} [opts]
 * @param {number} [opts.min=-100] — lowest allowed disposition value
 * @param {number} [opts.max=100] — highest allowed disposition value
 * @param {number} [opts.defaultValue=0] — value for an NPC never adjusted
 * @param {Tier[]} [opts.tiers] — [minScore, name] pairs; defaults to the 5-tier hostile→devoted ladder
 * @param {number} [opts.historyLimit=50] — max history entries kept per NPC
 * @returns {{
 *   get: (npcId:string) => number,
 *   adjust: (npcId:string, delta:number, reason?:string) => {value:number, tier:string, changed:boolean},
 *   tier: (npcId:string) => string,
 *   history: (npcId:string) => HistoryEntry[],
 *   serialize: () => {npcs: Record<string, NpcRecord>},
 *   load: (data:{npcs?: Record<string, NpcRecord>}) => object,
 * }}
 */
export function createDispositionTracker(opts = {}) {
  const min = opts.min != null ? opts.min : -100;
  const max = opts.max != null ? opts.max : 100;
  const defaultValue = opts.defaultValue != null ? opts.defaultValue : 0;
  const tiers = Array.isArray(opts.tiers) && opts.tiers.length ? opts.tiers : DEFAULT_TIERS;
  const historyLimit = opts.historyLimit != null ? opts.historyLimit : 50;

  /** @type {Map<string, {value:number, history:HistoryEntry[]}>} */
  const state = new Map();

  const clamp = (v) => Math.min(max, Math.max(min, v));

  /** Highest tier whose minScore <= value (falls back to the lowest tier). */
  function tierFor(value) {
    let best = null;
    for (const t of tiers) {
      if (t[0] <= value && (!best || t[0] > best[0])) best = t;
    }
    return (best || tiers[0])[1];
  }

  function record(npcId) {
    let rec = state.get(npcId);
    if (!rec) {
      rec = { value: clamp(defaultValue), history: [] };
      state.set(npcId, rec);
    }
    return rec;
  }

  /** Current disposition value for an NPC (defaultValue if never adjusted). */
  function get(npcId) {
    const rec = state.get(npcId);
    return rec ? rec.value : clamp(defaultValue);
  }

  /** Current tier name for an NPC. */
  function tier(npcId) {
    return tierFor(get(npcId));
  }

  /**
   * Adjust an NPC's disposition by `delta` (clamped to [min, max]).
   * @param {string} npcId
   * @param {number} delta
   * @param {string} [reason]
   * @returns {{value:number, tier:string, changed:boolean}} changed = tier name differs from before the adjust
   */
  function adjust(npcId, delta, reason) {
    const rec = record(npcId);
    const beforeTier = tierFor(rec.value);
    rec.value = clamp(rec.value + delta);
    const afterTier = tierFor(rec.value);
    rec.history.push({ delta, reason: reason != null ? reason : null, at: Date.now() });
    while (rec.history.length > historyLimit) rec.history.shift();
    return { value: rec.value, tier: afterTier, changed: afterTier !== beforeTier };
  }

  /** Adjustment history for an NPC, oldest first, capped at historyLimit. */
  function history(npcId) {
    const rec = state.get(npcId);
    return rec ? rec.history.map((h) => ({ ...h })) : [];
  }

  /** Plain-JSON snapshot of all tracked NPCs (see module doc re: opts). */
  function serialize() {
    const npcs = {};
    for (const [id, rec] of state) {
      npcs[id] = { value: rec.value, history: rec.history.map((h) => ({ ...h })) };
    }
    return { npcs };
  }

  /**
   * Replace this tracker's state from a `serialize()` snapshot. Clamps values
   * and re-caps history to THIS tracker's opts, so loading data produced by a
   * differently-configured tracker is safe. Returns the tracker for chaining.
   */
  function load(data) {
    state.clear();
    const npcs = (data && data.npcs) || {};
    for (const [id, rec] of Object.entries(npcs)) {
      const value = clamp(rec && rec.value != null ? rec.value : defaultValue);
      const rawHistory = (rec && Array.isArray(rec.history)) ? rec.history : [];
      const trimmed = rawHistory.slice(-historyLimit).map((h) => ({
        delta: h.delta,
        reason: h.reason != null ? h.reason : null,
        at: h.at,
      }));
      state.set(id, { value, history: trimmed });
    }
    return tracker;
  }

  const tracker = { get, adjust, tier, history, serialize, load };
  return tracker;
}
