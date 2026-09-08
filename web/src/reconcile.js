// Keyed DOM reconciliation for list regions that re-render on every activity
// tick (the sidebar). replaceChildren() rebuilds the whole subtree each tick →
// any hovered / focused / mid-press row is detached and its :hover, focus and
// in-flight pointer capture are lost (hover flicker, missed clicks). This keeps
// node IDENTITY: a row's DOM node is reused verbatim across renders whose
// visible + handler state (its version stamp) is unchanged, so only rows that
// actually changed rebuild, and containers are never replaced wholesale.
//
// Two reuse disciplines (mirrors transcript.js's keyed sync, generalised):
//   - persistent(key): a container / static node built ONCE, same instance for
//     the cache's life — its children are reconciled separately, so it is never
//     detached and everything under it survives.
//   - keyed(key, version, build): a leaf row reused while its version string is
//     unchanged; the moment it changes the row is rebuilt so its event handlers
//     never close over stale data (no blanket stale-render suppression).
// Nodes not requested during a render pass are pruned after it.

/**
 * Move a parent's children into the exact order of `nodes`, inserting / moving
 * only where the live DOM already differs and removing any child not present.
 * Every carried-over node keeps its identity (and thus :hover / focus / pointer
 * capture). Same algorithm the transcript uses for its keyed message sync.
 * @param {Node} parent @param {Node[]} nodes
 */
export function syncChildren(parent, nodes) {
  const keep = new Set(nodes);
  for (const child of [...parent.childNodes]) {
    if (!keep.has(child)) parent.removeChild(child);
  }
  let ref = parent.firstChild;
  for (const node of nodes) {
    if (node === ref) {
      ref = node.nextSibling;
      continue;
    }
    // insertBefore moves an already-present node without recreating it, so the
    // node's identity (and any live :hover / focus / capture) is preserved.
    parent.insertBefore(node, ref);
  }
}

/** @typedef {{ node: Node, version: string|null }} CacheEntry */

/**
 * A per-region node cache. begin() opens a render pass, persistent()/keyed()
 * fetch or (re)build nodes, prune() drops whatever the pass did not request.
 */
export class NodeCache {
  constructor() {
    /** @type {Map<string, CacheEntry>} */
    this.map = new Map();
    /** @type {Set<string>} */
    this.used = new Set();
  }

  /** Open a render pass: forget which keys the previous pass touched. */
  begin() {
    this.used = new Set();
  }

  /**
   * A container / static node: built once, the SAME instance for the cache's
   * life so it is never detached (its children are reconciled separately).
   * @param {string} key @param {() => Node} build @returns {Node}
   */
  persistent(key, build) {
    this.used.add(key);
    let entry = this.map.get(key);
    if (!entry) {
      entry = { node: build(), version: null };
      this.map.set(key, entry);
    }
    return entry.node;
  }

  /**
   * A leaf whose node is reused only while `version` is unchanged; any change
   * rebuilds it so its handlers never close over stale data.
   * @param {string} key @param {string} version @param {() => Node} build @returns {Node}
   */
  keyed(key, version, build) {
    this.used.add(key);
    let entry = this.map.get(key);
    if (!entry || entry.version !== version) {
      entry = { node: build(), version };
      this.map.set(key, entry);
    }
    return entry.node;
  }

  /** Drop entries not requested since the last begin(). Call after a pass. */
  prune() {
    for (const key of [...this.map.keys()]) {
      if (!this.used.has(key)) this.map.delete(key);
    }
  }
}
