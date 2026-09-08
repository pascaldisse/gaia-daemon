// Regression tests for the sidebar's keyed DOM reconciliation (web/src/reconcile.js).
// The sidebar re-renders on every activity tick; before this, renderSidebar did a
// full replaceChildren, detaching every row — a hovered / focused / mid-press row
// lost its :hover, focus and pointer capture (hover flicker, missed clicks; parent
// CDP proof: original row disconnected / hover=false across all same-room ticks).
// These assert the identity guarantees the fix relies on, against real Node-graph
// semantics (insertBefore MOVES a node, keeping its identity):
//   - DOM identity kept across an unchanged tick (a mid-press row survives)
//   - status / title / selection change → that row (only) rebuilds w/ fresh handlers
//   - reorder keeps node identities, DOM order follows
//   - removal drops exactly the gone node
import { test } from "bun:test";
import assert from "node:assert/strict";

import { NodeCache, setAttr, setClass, setText, syncChildren } from "../web/src/reconcile.js";
import { MElement } from "./helpers/mini-dom.js";

// Minimal real DOM-node graph: insertBefore relocates (never clones) a node, so
// carried-over instances keep identity — the property the whole fix rests on.
class N {
  tag: string;
  parent: N | null = null;
  kids: N[] = [];
  mark?: string;
  constructor(tag = "") { this.tag = tag; }
  get childNodes(): N[] { return this.kids; }
  get firstChild(): N | null { return this.kids[0] ?? null; }
  get nextSibling(): N | null {
    if (!this.parent) return null;
    const i = this.parent.kids.indexOf(this);
    return this.parent.kids[i + 1] ?? null;
  }
  removeChild(c: N): N {
    const i = this.kids.indexOf(c);
    if (i >= 0) { this.kids.splice(i, 1); c.parent = null; }
    return c;
  }
  insertBefore(node: N, ref: N | null): N {
    if (node.parent) node.parent.removeChild(node);
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i >= 0) this.kids.splice(i, 0, node); else this.kids.push(node);
    node.parent = this;
    return node;
  }
  appendChild(node: N): N { return this.insertBefore(node, null); }
}

function sync(parent: N, nodes: N[]): void {
  syncChildren(parent as unknown as Node, nodes as unknown as Node[]);
}
function ids(parent: N): string[] {
  return parent.kids.map((k) => k.tag);
}

test("syncChildren keeps node identity across an unchanged tick (mid-press row survives)", () => {
  const parent = new N("nav");
  const a = new N("a"), b = new N("b"), c = new N("c");
  sync(parent, [a, b, c]);
  assert.deepEqual(parent.kids, [a, b, c]);
  // A second render with the SAME node instances (an activity tick that touched
  // none of these rows) must not detach any of them.
  sync(parent, [a, b, c]);
  assert.deepEqual(parent.kids, [a, b, c]);
  assert.equal(parent.kids[1], b); // same instance — a press captured on b outlives the tick
});

test("syncChildren reorders in place, preserving every node's identity", () => {
  const parent = new N("nav");
  const a = new N("a"), b = new N("b"), c = new N("c");
  sync(parent, [a, b, c]);
  sync(parent, [c, a, b]);
  assert.deepEqual(ids(parent), ["c", "a", "b"]);
  // Same instances, just moved — not rebuilt.
  assert.equal(parent.kids[0], c);
  assert.equal(parent.kids[1], a);
  assert.equal(parent.kids[2], b);
});

test("syncChildren removes exactly the gone node and inserts a new one", () => {
  const parent = new N("nav");
  const a = new N("a"), b = new N("b"), c = new N("c");
  sync(parent, [a, b, c]);
  sync(parent, [a, c]); // b removed
  assert.deepEqual(ids(parent), ["a", "c"]);
  assert.equal(b.parent, null);
  const d = new N("d");
  sync(parent, [a, d, c]); // d inserted mid-list
  assert.deepEqual(ids(parent), ["a", "d", "c"]);
  assert.equal(parent.kids[0], a); // untouched neighbours keep identity
  assert.equal(parent.kids[2], c);
});

test("NodeCache.keyed reuses a node while its version is unchanged", () => {
  const cache = new NodeCache();
  let builds = 0;
  const get = () => {
    cache.begin();
    const node = cache.keyed("room:r1", "active=false|running=false", () => { builds++; return new N("row"); });
    cache.prune();
    return node;
  };
  const first = get();
  const second = get();
  assert.equal(first, second); // same instance — hover / focus / press preserved
  assert.equal(builds, 1); // never rebuilt while version held
});

test("NodeCache.keyed rebuilds (fresh handlers) when status/title/selection changes", () => {
  const cache = new NodeCache();
  const render = (version: string, handlerData: string) => {
    cache.begin();
    const node = cache.keyed("room:r1", version, () => {
      const n = new N("row");
      n.mark = handlerData; // stands in for a handler closing over current data
      return n;
    });
    cache.prune();
    return node;
  };
  const idle = render("active=false|running=false", "snapshot#1");
  const running = render("active=false|running=true", "snapshot#2");
  assert.notEqual(idle, running); // version change → new node
  assert.equal(running.mark, "snapshot#2"); // rebuilt with the LATEST handler data, no stale closure
  // selection flip is just another version change → rebuild again
  const selected = render("active=true|running=true", "snapshot#3");
  assert.notEqual(running, selected);
  assert.equal(selected.mark, "snapshot#3");
});

test("NodeCache.persistent returns one stable instance for the cache's life", () => {
  const cache = new NodeCache();
  let builds = 0;
  const get = () => {
    cache.begin();
    const node = cache.persistent("favorites-list", () => { builds++; return new N("ul"); });
    cache.prune();
    return node;
  };
  const a = get();
  const b = get();
  assert.equal(a, b);
  assert.equal(builds, 1);
});

test("NodeCache.prune drops entries a render pass did not request (room removed)", () => {
  const cache = new NodeCache();
  const build = () => new N("row");
  // Pass 1: two rooms present.
  cache.begin();
  const r1a = cache.keyed("room:r1", "v", build);
  cache.keyed("room:r2", "v", build);
  cache.prune();
  assert.equal(cache.map.size, 2);
  // Pass 2: r2 gone from the snapshot — not requested → pruned.
  cache.begin();
  const r1b = cache.keyed("room:r1", "v", build);
  cache.prune();
  assert.equal(cache.map.size, 1);
  assert.equal(r1a, r1b); // surviving room kept its identity
});

test("NodeCache.component builds once and patches in place — the node instance is stable across updates", () => {
  const cache = new NodeCache();
  let builds = 0;
  /** @param {{ label: string }} data */
  const build = (data: { label: string }) => {
    builds++;
    const el = new MElement("button");
    el.textContent = data.label;
    return { node: el as unknown as Node, update: (d: { label: string }) => { (el as any).textContent = d.label; } };
  };
  const render = (label: string) => {
    cache.begin();
    const node = cache.component("row:r1", { label }, build as any) as unknown as MElement;
    cache.prune();
    return node;
  };
  const first = render("hello");
  const second = render("world");
  assert.equal(first, second, "same node instance — never rebuilt/detached");
  assert.equal(builds, 1, "built exactly once");
  assert.equal(second.textContent, "world", "patched in place to the latest data");
});

test("setClass / setText / setAttr write only the changed value; setAttr removes on null/false", () => {
  const el = new MElement("button");
  setClass(el as any, "a b");
  assert.equal(el.className, "a b");
  setText(el as any, "hi");
  assert.equal(el.textContent, "hi");
  setAttr(el as any, "title", "t1");
  assert.equal(el.getAttribute("title"), "t1");
  setAttr(el as any, "title", null);
  assert.equal(el.hasAttribute("title"), false, "null removes the attribute");
  setAttr(el as any, "style", "x:1");
  assert.equal(el.getAttribute("style"), "x:1");
  setAttr(el as any, "style", false);
  assert.equal(el.hasAttribute("style"), false, "false removes the attribute");
});

test("end-to-end: an activity tick that toggles ONE room's running dot keeps every other row's node", () => {
  const cache = new NodeCache();
  const list = new N("room-tree");
  const rooms = [
    { id: "r1", running: false },
    { id: "r2", running: false },
    { id: "r3", running: false },
  ];
  const renderPass = () => {
    cache.begin();
    const container = cache.persistent("room-tree", () => list);
    const nodes = rooms.map((room) =>
      cache.keyed(`room-row:${room.id}`, `running=${room.running}`, () => new N(room.id)),
    );
    sync(container as unknown as N, nodes as unknown as N[]);
    cache.prune();
  };
  renderPass();
  const before = [...list.kids];
  // r2 starts running (one dot toggles) — the activity tick that used to nuke all rows.
  rooms[1].running = true;
  renderPass();
  assert.equal(list.kids[0], before[0]); // r1 node untouched
  assert.notEqual(list.kids[1], before[1]); // r2 rebuilt (its version changed)
  assert.equal(list.kids[2], before[2]); // r3 node untouched
  assert.deepEqual(ids(list), ["r1", "r2", "r3"]); // order intact
});
