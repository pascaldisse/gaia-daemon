/**
 * shared/visibility.js — per-seat visibility filter for DMView.
 *
 * The DM seat sees EVERYTHING; non-DM seats (player/npc/spectator) must NOT
 * receive private authoring/AI content. The server will filter every outgoing
 * WS message through this pure module before sending.
 *
 * PURE — no server/client imports, no fs, no mutation of inputs.
 */

// ---- Exported constants ----

/** Components hidden entirely from non-DM seats. */
export const PRIVATE_COMPONENTS = ['persona', 'knowledge', 'lifelog'];

/** For non-DM seats, the `agent` component is reduced to just these fields.
 *  `controller` is public: it is a player's name (seat ownership drives the
 *  multiplayer HUD), never AI internals. */
export const AGENT_PUBLIC_FIELDS = ['enabled', 'accent', 'controller'];

// ---- Seat-to-audience gating ----

/**
 * True if a message addressed to `audience` should reach a client in `seat`.
 *
 * @param {'all'|'dm'|'players'} audience — intended audience
 * @param {'dm'|'player'|'npc'|'spectator'} seat — receiving client seat
 * @returns {boolean}
 */
export function seatSees(audience, seat) {
  if (audience === 'all') return true;
  if (audience === 'dm') return seat === 'dm';
  if (audience === 'players') return seat !== 'dm';
  return false;
}

// ---- Component redaction ----

/**
 * Redact one entity's components object for a seat.
 * seat 'dm' → returns a deep clone unchanged.
 * Non-dm → returns a NEW object with PRIVATE_COMPONENTS removed and `agent`
 * reduced to AGENT_PUBLIC_FIELDS (if present). Never mutates the input.
 *
 * @param {Record<string, object>} comps — entity components
 * @param {'dm'|'player'|'npc'|'spectator'} seat
 * @returns {Record<string, object>}
 */
export function redactComponentsForSeat(comps, seat) {
  if (seat === 'dm') {
    // Deep clone so the caller can safely mutate
    const clone = {};
    for (const key of Object.keys(comps)) {
      clone[key] = JSON.parse(JSON.stringify(comps[key]));
    }
    return clone;
  }

  const out = {};
  for (const key of Object.keys(comps)) {
    if (PRIVATE_COMPONENTS.includes(key)) continue;

    if (key === 'agent') {
      // Reduce to public fields only
      const reduced = {};
      for (const f of AGENT_PUBLIC_FIELDS) {
        if (f in comps[key]) {
          reduced[f] = comps[key][f];
        }
      }
      out[key] = reduced;
      continue;
    }

    // Keep intact (deep clone for safety)
    out[key] = JSON.parse(JSON.stringify(comps[key]));
  }
  return out;
}

// ---- Message redaction ----

/**
 * Redact an outgoing WS message for a seat.
 *
 * seat 'dm' → return msg unchanged.
 * Non-dm:
 *  - {type:'snapshot', entities:{…}, …} → new msg with every entity redacted.
 *  - {type:'ops', ops:[…]} → new msg with each op redacted; returns null if
 *    the resulting ops array is empty.
 *  - any other message (events, errors, etc.) → return as-is.
 *
 * Never mutates the input. Returns the (possibly new) message, or null.
 *
 * @param {object} msg — outgoing WS message
 * @param {'dm'|'player'|'npc'|'spectator'} seat
 * @returns {object|null}
 */
export function redactForSeat(msg, seat) {
  if (seat === 'dm') return msg;

  // Snapshot message: redact every entity
  if (msg.type === 'snapshot') {
    const out = { ...msg };
    const entities = {};
    for (const [id, comps] of Object.entries(msg.entities)) {
      entities[id] = redactComponentsForSeat(comps, seat);
    }
    out.entities = entities;
    return out;
  }

  // Ops message: redact each op, drop empty
  if (msg.type === 'ops') {
    const redacted = [];
    for (const op of msg.ops) {
      const result = redactOp(op, seat);
      if (result !== null) redacted.push(result);
    }
    if (redacted.length === 0) return null;
    return { ...msg, ops: redacted };
  }

  // All other message types (narration, dialogue, system events, errors, etc.)
  // pass through — audience-gating handles DM-only events upstream.
  return msg;
}

// ---- Op redaction (internal) ----

/**
 * Redact a single op for a non-dm seat.
 * Returns the op (possibly modified), or null to drop it entirely.
 *
 * @param {object} op
 * @param {'player'|'npc'|'spectator'} seat
 * @returns {object|null}
 * @private
 */
function redactOp(op, seat) {
  // spawn: keep, but redact components
  if (op.op === 'spawn') {
    const components = op.components
      ? redactComponentsForSeat(op.components, seat)
      : {};
    return { ...op, components };
  }

  // set / merge: component-level filtering
  if (op.op === 'set' || op.op === 'merge') {
    // Private component → drop
    if (PRIVATE_COMPONENTS.includes(op.component)) return null;

    // agent → reduce value to public fields
    if (op.component === 'agent') {
      const reduced = {};
      for (const f of AGENT_PUBLIC_FIELDS) {
        if (f in op.value) {
          reduced[f] = op.value[f];
        }
      }
      return { ...op, value: reduced };
    }

    // Keep unchanged
    return op;
  }

  // All other op kinds pass through unchanged
  // (damage, heal, giveItem, take, drop, move, setFlag, event, action, roll, reset, despawn)
  return op;
}
