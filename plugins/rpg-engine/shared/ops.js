/**
 * shared/ops.js — op vocabulary, applyOp, validation, and $-token substitution.
 *
 * PURE — no imports from server/ or client/. Depends only on shared/schema.js and zod.
 *
 * EXTENSION SEAM: add new op kinds to the handlerRegistry below.
 * The server's broadcast pipeline handles new op types automatically as long as
 * they have a handler (or are marked ephemeral-only like event/action/roll).
 */

import { z } from 'zod';
import { SCHEMA } from './schema.js';
import { semanticOpTypes } from './effects.js';

// ---- Op shapes (Zod schemas) ----

const spawnSchema = z.object({
  op: z.literal('spawn'),
  id: z.string().optional(),
  components: z.record(z.string(), z.unknown()),
});

const setSchema = z.object({
  op: z.literal('set'),
  id: z.string(),
  component: z.string(),
  value: z.unknown().nullable(),
});

const mergeSchema = z.object({
  op: z.literal('merge'),
  id: z.string(),
  component: z.string(),
  value: z.record(z.string(), z.unknown()),
});

const despawnSchema = z.object({
  op: z.literal('despawn'),
  id: z.string(),
});

const eventSchema = z.object({
  op: z.literal('event'),
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const actionSchema = z.object({
  op: z.literal('action'),
  text: z.string(),
  by: z.string().optional(),
  mode: z.string().optional(),
  move: z.string().optional(),    // C1: declared Move name from the actor's moves.list
  target: z.string().optional(),  // C1: target entity id
  zone: z.string().optional(),    // C4: move within combat to this zone id
});

const rollSchema = z.object({
  op: z.literal('roll'),
  expr: z.string(),
  by: z.string().optional(),
  reason: z.string().optional(),
  dc: z.number().optional(),
});

const resetSchema = z.object({
  op: z.literal('reset'),
  scene: z.string().optional(),
});

// ---- Semantic ops (expanded before apply via effects.js) ----
// These validate the LLM's output shape but are NOT entity mutators themselves.
// Effects.js expands them into canonical spawn/set/merge/despawn ops.
// EXTENSION SEAM: rulesets add semantic ops here and in effects.js SEMANTIC_HANDLERS.

const damageSchema = z.object({
  op: z.literal('damage'),
  id: z.string(),
  amount: z.number().min(0),
});

const healSchema = z.object({
  op: z.literal('heal'),
  id: z.string(),
  amount: z.number().min(0),
});

const giveItemSchema = z.object({
  op: z.literal('giveItem'),
  id: z.string(),
  item: z.object({ id: z.string(), name: z.string().optional(), qty: z.number().optional() }),
});

const takeItemSchema = z.object({
  op: z.literal('takeItem'),
  id: z.string(),
  item: z.object({ id: z.string() }),
});

const moveSchema = z.object({
  op: z.literal('move'),
  id: z.string(),
  to: z.string(),
});

const takeSchema = z.object({
  op: z.literal('take'),
  id: z.string(),
  item: z.object({ id: z.string(), name: z.string().optional(), qty: z.number().optional() }),
});

const dropSchema = z.object({
  op: z.literal('drop'),
  id: z.string(),
  item: z.object({ id: z.string() }),
  to: z.string().optional(),
});

const setFlagSchema = z.object({
  op: z.literal('setFlag'),
  key: z.string(),
  value: z.unknown(),
  id: z.string().optional(),
});

const applyStatusSchema = z.object({
  op: z.literal('applyStatus'),
  id: z.string(),
  kind: z.string(),
  magnitude: z.number().optional(),
  remaining: z.number(),
  source: z.string().optional(),
});

const removeStatusSchema = z.object({
  op: z.literal('removeStatus'),
  id: z.string(),
  kind: z.string(),
});

const spawnHazardSchema = z.object({
  op: z.literal('spawnHazard'),
  zoneId: z.string(),
  kind: z.string(),
  magnitude: z.number().optional(),
  remaining: z.number().optional(),
});

const clearHazardSchema = z.object({
  op: z.literal('clearHazard'),
  zoneId: z.string(),
  kind: z.string().optional(),
});

const moveZoneSchema = z.object({
  op: z.literal('moveZone'),
  id: z.string(),
  zoneId: z.string(),
});

const setMeterSchema = z.object({
  op: z.literal('setMeter'),
  id: z.string(),
  key: z.string(),
  value: z.number(),
});

export const opUnion = z.discriminatedUnion('op', [
  spawnSchema, setSchema, mergeSchema, despawnSchema,
  eventSchema, actionSchema, rollSchema, resetSchema,
  damageSchema, healSchema, giveItemSchema, takeItemSchema, moveSchema, setFlagSchema,
  takeSchema, dropSchema, applyStatusSchema, removeStatusSchema,
  spawnHazardSchema, clearHazardSchema, moveZoneSchema, setMeterSchema,
]);

const batchSchema = z.array(opUnion);

/** The op kinds the static union above covers (strictly schema-validated). */
const BUILTIN_KINDS = new Set([
  'spawn', 'set', 'merge', 'despawn', 'event', 'action', 'roll', 'reset',
  'damage', 'heal', 'giveItem', 'takeItem', 'move', 'setFlag',
  'take', 'drop', 'applyStatus', 'removeStatus',
  'spawnHazard', 'clearHazard', 'moveZone', 'setMeter',
]);

/**
 * Validate a single op or batch of ops.
 * Returns {ok:true, ops} or {ok:false, error:string}.
 *
 * Ruleset/addon-REGISTERED semantic ops (registerEffects) are accepted with a
 * minimal shape check — each handler is its own validator/clamp (that is the
 * contract), and the registry isn't known at schema-definition time.
 */
export function validateOpBatch(ops) {
  const arr = Array.isArray(ops) ? ops : [ops];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const op = arr[i];
    const kind = op && typeof op === 'object' ? op.op : null;
    if (kind && !BUILTIN_KINDS.has(kind) && semanticOpTypes().includes(kind)) {
      out.push(op);
      continue;
    }
    const r = opUnion.safeParse(op);
    if (!r.success) {
      return {
        ok: false,
        error: r.error.errors.map(err => `[${[i, ...err.path].join('.')}] ${err.message}`).join('; '),
      };
    }
    out.push(r.data);
  }
  return { ok: true, ops: out };
}

/**
 * Validate a single op. Convenience wrapper.
 */
export function validateOp(op) {
  const result = validateOpBatch([op]);
  if (!result.ok) return result;
  return { ok: true, op: result.ops[0] };
}

// ---- Handler registry (EXTENSION SEAM) ----

/**
 * Handlers for entity-mutating ops.
 * Each handler receives (entities Map, op, counterRef {value:number}).
 * Returns: {ok:true, id?, broadcast:true, canon:true} or {ok:false, error}.
 *
 * broadcast:true means the server broadcasts this op to all clients.
 * canon:true means the op is persisted to the session save.
 * ephemeral ops are broadcast+journaled but never persisted.
 *
 * Add new op kinds by adding a handler here.
 */
export const handlerRegistry = {
  spawn(entities, op, counterRef) {
    // Auto-assign id if missing
    const id = op.id || `e${++counterRef.value}`;
    if (entities.has(id)) {
      return { ok: false, error: `Entity ${id} already exists (use merge or set, not spawn).` };
    }
    const comps = {};
    for (const [name, val] of Object.entries(op.components || {})) {
      comps[name] = JSON.parse(JSON.stringify(val));
    }
    entities.set(id, comps);
    return { ok: true, id, broadcast: true, canon: true };
  },

  set(entities, op, _counterRef) {
    if (!entities.has(op.id)) {
      return { ok: false, error: `Entity ${op.id} not found.` };
    }
    const comps = entities.get(op.id);
    if (op.value === null) {
      delete comps[op.component];
    } else {
      comps[op.component] = JSON.parse(JSON.stringify(op.value));
    }
    return { ok: true, id: op.id, component: op.component, broadcast: true, canon: true };
  },

  merge(entities, op, counterRef) {
    // Materialize entity if missing (GAIA's "merge materializes")
    if (!entities.has(op.id)) {
      entities.set(op.id, {});
    }
    const comps = entities.get(op.id);
    if (!comps[op.component]) {
      comps[op.component] = {};
    }
    Object.assign(comps[op.component], JSON.parse(JSON.stringify(op.value)));
    return { ok: true, id: op.id, component: op.component, broadcast: true, canon: true };
  },

  despawn(entities, op, _counterRef) {
    if (!entities.has(op.id)) {
      return { ok: false, error: `Entity ${op.id} not found.` };
    }
    entities.delete(op.id);
    return { ok: true, id: op.id, broadcast: true, canon: true };
  },
};

/**
 * Apply a single op to an entities Map.
 * Canon-mutating ops (spawn/set/merge/despawn) go through the handlerRegistry.
 * Ephemeral ops (event/action/roll) return canon:false.
 * Reset is handled by the server (file I/O) — returns a flag.
 *
 * @param {Map<string, object>} entities
 * @param {object} op
 * @param {{value:number}} counterRef — mutable counter reference for auto-id
 * @returns {{ok:boolean, error?:string, id?:string, component?:string, broadcast?:boolean, canon?:boolean, isReset?:boolean, scene?:string}}
 */
export function applyOp(entities, op, counterRef) {
  const kind = op.op;

  // Canon handlers
  if (kind in handlerRegistry) {
    return handlerRegistry[kind](entities, op, counterRef);
  }

  // Ephemeral ops — broadcast+journal only, never persist
  if (kind === 'event' || kind === 'action' || kind === 'roll') {
    return { ok: true, broadcast: true, canon: false };
  }

  // Reset — handled server-side
  if (kind === 'reset') {
    return { ok: true, isReset: true, scene: op.scene || null, broadcast: true, canon: false };
  }

  // Unknown op kind — lenient
  return { ok: false, error: `Unknown op kind: ${kind}` };
}

// ---- $-token substitution ----


/**
 * Check if an op kind mutates entity state (canon).
 */
export function isCanonOp(op) {
  return ['spawn', 'set', 'merge', 'despawn'].includes(op.op);
}
