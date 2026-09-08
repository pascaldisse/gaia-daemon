// Keyed DOM reconciliation for list regions that re-render on every activity
// tick (the sidebar). replaceChildren() rebuilt the whole subtree each tick →
// any hovered / focused / mid-press row was detached and its :hover, focus and
// in-flight pointer capture were lost (hover flicker, missed clicks; parent CDP
// proof: the active row came back disconnected, hover=false, on every same-room
// tick). A version-stamp rebuild is NOT enough either: the active / streaming
// row's lastActivity ticks constantly, so any rebuild-on-change still detaches
// exactly the row you're on. So rows are patched IN PLACE instead — see
// component() — the button node is created once and never replaced.
//
// Three reuse disciplines:
//   - persistent(key): a container / static node built ONCE, same instance for
//     the cache's life — children reconciled separately, never detached.
//   - component(key, data, build): a STATEFUL node built once whose update(data)
//     mutates it in place every later pass — the node (and its native focus,
//     :hover, pointer capture) is never lost. Listeners bind once over a mutable
//     data ref, so a click after an update acts on the LATEST data (h binds via
//     addEventListener, so reassigning onX would not work and re-adding would
//     duplicate — the data ref sidesteps both).
//   - keyed(key, version, build): a leaf reused while version is unchanged,
//     rebuilt on change. Only for rarely-changing chrome (headers, menus,
//     "show more") where a rebuild never lands on a hovered row.
// Nodes not requested during a pass are pruned after it.

/**
 * Move a parent's children into the exact order of `nodes`, inserting / moving
 * only where the live DOM already differs and removing any child not present.
 * A carried-over node is only ever MOVED when the desired order changed (a
 * drag reorder); a row whose data merely updated keeps its slot and is never
 * touched here — so an in-place-patched active row is never moved. (Moving a
 * node across the DOM can drop native focus, so we avoid it unless order truly
 * differs.) Same algorithm as transcript.js's keyed message sync.
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
    const focus = /** @type {HTMLElement|null|undefined} */ (node.ownerDocument?.activeElement);
    const restoreFocus = focus && node.contains(focus);
    parent.insertBefore(node, ref);
    if (restoreFocus && focus?.isConnected && focus.ownerDocument.activeElement !== focus) {
      focus.focus({ preventScroll: true });
    }
  }
}

/** @typedef {{ node: Node, version?: string, update?: (data: any) => void }} CacheEntry */

/**
 * A per-region node cache. begin() opens a pass, the getters fetch / build /
 * patch nodes, prune() drops whatever the pass did not request.
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
      entry = { node: build() };
      this.map.set(key, entry);
    }
    return entry.node;
  }

  /**
   * A stateful node patched IN PLACE: build(data) creates the node ONCE and
   * returns { node, update }; update(data) mutates it on every pass (including
   * the first). The node identity — and thus its native focus, :hover and
   * pointer capture — is never lost across title / status / selection /
   * activity updates.
   * @template D
   * @param {string} key @param {D} data
   * @param {(data: D) => { node: Node, update: (data: D) => void }} build
   * @returns {Node}
   */
  component(key, data, build) {
    this.used.add(key);
    let entry = this.map.get(key);
    if (!entry || !entry.update) {
      entry = build(data);
      this.map.set(key, entry);
    }
    entry.update?.(data);
    return entry.node;
  }

  /**
   * A leaf reused only while `version` is unchanged; any change rebuilds it.
   * For rarely-changing chrome only — rows use component().
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

// --- in-place DOM patch helpers: each writes only when the value differs, so
// an unchanged tick touches nothing (no reflow, no flicker). ---------------

/** @param {HTMLElement} el @param {string} cls */
export function setClass(el, cls) {
  if (el.className !== cls) el.className = cls;
}

/** @param {HTMLElement} el @param {string} text */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {HTMLElement} el @param {string} name @param {string|null|undefined|false|true} value */
export function setAttr(el, name, value) {
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const next = value === true ? "" : String(value);
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
}
