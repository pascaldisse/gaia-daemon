// Snapshot rooms -> archtree model. Pure functions only: no DOM, no WebGL, no
// client state import, so the whole thing is testable headless (see
// test/archtree-model.test.ts). The edge set is exactly the sidebar's:
// room.parentRoomId, an unbounded summon hierarchy.

import { resolveParams } from "./params.js";

/** @typedef {import("./params.js").ArchtreeParams} ArchtreeParams */

/**
 * The subset of RoomSummary the model needs. Kept structural on purpose so the
 * model never depends on the server type evolving.
 * @typedef {Object} ArchtreeRoom
 * @property {string} id
 * @property {string} [path]
 * @property {string} [parentRoomId]
 * @property {boolean} [running]
 * @property {string} [title]
 * @property {boolean} [favorite]
 * @property {boolean} [incognito]
 * @property {number} [lastActivity]
 */

/** @typedef {"active"|"done"|"dead"|"idle"} ArchtreeStatus */

/**
 * @typedef {Object} ArchtreeNode
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} label agent/room label shown on the node
 * @property {number} depth 0 = root
 * @property {number} index sibling index among its parent's children
 * @property {number} siblings how many children the parent has
 * @property {number} descendants transitive child count (branch thickness)
 * @property {ArchtreeStatus} status
 * @property {boolean} favorite
 * @property {boolean} incognito
 * @property {number} lastActivity 0 when unknown
 */

/**
 * @typedef {Object} ArchtreeModel
 * @property {ArchtreeNode[]} nodes topological order (parents before children)
 * @property {Array<{from: string, to: string}>} edges
 * @property {number} maxDepth
 * @property {boolean} anyActive
 * @property {ArchtreeParams} params
 */

/**
 * Label for a node: the room title if set, else the trailing segment of its
 * path, else the raw id. Summon rooms are named `<agent>-<suffix>`, so the
 * agent name is the part before the last dash when a suffix is present.
 * @param {ArchtreeRoom} room
 * @returns {string}
 */
export function nodeLabel(room) {
  const title = (room.title ?? "").trim();
  if (title) return title;
  const path = (room.path ?? "").trim();
  const tail = path ? (path.split("/").pop() ?? "") : "";
  const base = tail || room.id;
  const dash = base.lastIndexOf("-");
  if (dash > 0 && base.length - dash > 8) return base.slice(0, dash);
  return base;
}

/**
 * Live status of one room, derived only from fields that actually exist today
 * (see DESIGN-ARCHTREE.md §2 for the missing `failed` bit).
 * @param {ArchtreeRoom} room
 * @param {number} now epoch ms
 * @param {ArchtreeParams} params
 * @returns {ArchtreeStatus}
 */
export function roomStatus(room, now, params) {
  if (room.running) return "active";
  const last = room.lastActivity ?? 0;
  if (!last) return "idle";
  const age = now - last;
  if (age <= params.freshMs) return "done";
  if (age >= params.witherMs) return "dead";
  return "idle";
}

/**
 * Build the model. Rooms whose parentRoomId points outside the given set are
 * treated as roots (same rule the sidebar uses), so a partial room list never
 * loses nodes. Cycles (impossible by construction, cheap to defend) are broken
 * by demoting the offending node to a root.
 * @param {ArchtreeRoom[]} rooms
 * @param {{now?: number, params?: Partial<ArchtreeParams>}} [opts]
 * @returns {ArchtreeModel}
 */
export function buildModel(rooms, opts = {}) {
  const params = resolveParams(opts.params);
  const now = opts.now ?? Date.now();
  const ids = new Set(rooms.map((room) => room.id));

  /** @type {Map<string, ArchtreeRoom>} */
  const byId = new Map();
  for (const room of rooms) byId.set(room.id, room);

  /** @param {ArchtreeRoom} room */
  const parentOf = (room) => {
    const parent = room.parentRoomId;
    if (!parent || parent === room.id || !ids.has(parent)) return null;
    // cycle guard: walk up, bail to root if we come back around
    const seen = new Set([room.id]);
    let cursor = byId.get(parent);
    while (cursor) {
      if (seen.has(cursor.id)) return null;
      seen.add(cursor.id);
      const next = cursor.parentRoomId;
      cursor = next && ids.has(next) ? byId.get(next) : undefined;
    }
    return parent;
  };

  /** @type {Map<string|null, ArchtreeRoom[]>} */
  const childrenOf = new Map();
  for (const room of rooms) {
    const parent = parentOf(room);
    const list = childrenOf.get(parent);
    if (list) list.push(room);
    else childrenOf.set(parent, [room]);
  }
  // stable ordering: oldest activity first, then id — layout must be
  // deterministic across renders or the tree would jitter every update.
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.lastActivity ?? 0) - (b.lastActivity ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** @type {ArchtreeNode[]} */
  const nodes = [];
  /** @type {Array<{from: string, to: string}>} */
  const edges = [];
  let maxDepth = 0;
  let anyActive = false;

  /**
   * @param {ArchtreeRoom[]} siblings
   * @param {string|null} parentId
   * @param {number} depth
   */
  const walk = (siblings, parentId, depth) => {
    siblings.forEach((room, index) => {
      const status = roomStatus(room, now, params);
      if (status === "active") anyActive = true;
      if (depth > maxDepth) maxDepth = depth;
      nodes.push({
        id: room.id,
        parentId,
        label: nodeLabel(room),
        depth,
        index,
        siblings: siblings.length,
        descendants: 0,
        status,
        favorite: Boolean(room.favorite),
        incognito: Boolean(room.incognito),
        lastActivity: room.lastActivity ?? 0,
      });
      if (parentId) edges.push({ from: parentId, to: room.id });
      walk(childrenOf.get(room.id) ?? [], room.id, depth + 1);
    });
  };
  walk(childrenOf.get(null) ?? [], null, 0);

  // descendant counts, computed bottom-up over the topological order
  /** @type {Map<string, ArchtreeNode>} */
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node?.parentId) continue;
    const parent = nodeById.get(node.parentId);
    if (parent) parent.descendants += node.descendants + 1;
  }

  return { nodes, edges, maxDepth, anyActive, params };
}
