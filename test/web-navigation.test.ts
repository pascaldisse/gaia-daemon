// Browser-relative design mount → bun test --preserve-symlinks test/web-navigation.test.ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createNavigation } from "../web/src/navigation.js";

class Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(i: number) { return [...this.values.keys()][i] ?? null; }
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { this.values.set(k, v); }
  removeItem(k: string) { this.values.delete(k); }
}
const storage = new Storage();
storage.setItem("gaia.events.transport", JSON.stringify({ transport: "sse", at: Date.now() }));
class Channel {
  static all: Channel[] = [];
  listeners = new Map<string, ((event: { data: string }) => void)[]>();
  closed = false;
  constructor(public url: string) { Channel.all.push(this); }
  addEventListener(type: string, fn: (event: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(type: string, payload: unknown) { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(payload) }); }
}
Object.assign(globalThis, {
  localStorage: storage, sessionStorage: storage,
  window: { localStorage: storage, sessionStorage: storage, setInterval, clearInterval, setTimeout, clearTimeout, addEventListener() {} },
  document: { visibilityState: "hidden", hasFocus: () => false, querySelector: () => null },
  requestAnimationFrame: () => 0,
  EventSource: Channel,
});
const { state } = await import("../web/src/state.js");
const { selectRoom, loadWorkspace } = await import("../web/src/actions.js");
const { connectEvents } = await import("../web/src/events.js");
const { navigation } = await import("../web/src/navigation.js");

function payload(ws: string, id: string) {
  return {
    snapshot: {
      workspace: { id: ws, path: ws },
      room: { id, events: [], eventTotal: 0 },
      rooms: ["a", "b", "c"].map(id => ({ id, path: id, isCurrent: false, lastActivity: 0 })),
      agents: [], tasks: [],
    },
    workspaceFiles: [], voice: null,
  } as any;
}
function cached(ws: string, id: string) { return { ...payload(ws, id), streams: new Map(), older: { roomId: id, events: [], loading: false, lastTotal: 0 } }; }
const pending: { url: string, options: RequestInit, resolve: (body: any) => void, reject: (error: Error) => void }[] = [];
function setup(ws: string) {
  state.snapshot = payload(ws, "a").snapshot;
  state.streams.clear();
  state.workspaceRooms = {};
  state.error = "";
  state.voice = null;
  state.older = { roomId: "a", events: [], loading: false, lastTotal: 0 };
  state.eventSource?.close();
  state.eventSource = null;
  pending.length = 0;
  globalThis.fetch = ((url: string, options: RequestInit = {}) => new Promise((resolve, reject) => {
    pending.push({ url, options, resolve: body => resolve(Response.json(body)), reject });
  })) as typeof fetch;
}

test("latest intent cancels old requests; stale finalizers cannot clear pending", () => {
  const nav = createNavigation();
  const a = nav.begin();
  const b = nav.begin();
  assert.equal(a.signal.aborted, true);
  nav.finish(a.id);
  assert.equal(nav.pending, true);
  assert.equal(nav.current(a.id), false);
  nav.finish(b.id);
  assert.equal(nav.pending, false);
});

test("cache is workspace-qualified, bounded LRU, and removable", () => {
  const nav = createNavigation({ maxEntries: 2 });
  nav.save(cached("one", "a"));
  nav.save(cached("two", "a"));
  assert.equal(nav.get("one")?.snapshot.workspace.id, "one");
  nav.save(cached("three", "a"));
  assert.equal(nav.get("two"), undefined);
  nav.forget("one", "a");
  assert.equal(nav.get("one"), undefined);
  nav.forget("three");
  assert.equal(nav.get("three"), undefined);
});

test("room requests resolving in reverse order keep the final clicked room", async () => {
  setup("race");
  const a = selectRoom("race", "b");
  const b = selectRoom("race", "c");
  assert.equal(pending[0].options.signal?.aborted, true);
  pending[1].resolve(payload("race", "c"));
  await b;
  pending[0].resolve(payload("race", "b"));
  await a;
  assert.equal(state.snapshot?.room.id, "c");
  assert.equal(navigation.pending, false);
});

test("workspace and room selections share the same last-intent guard; stale errors ignored", async () => {
  setup("cross");
  const a = loadWorkspace("other");
  const b = selectRoom("cross", "b");
  pending[1].resolve(payload("cross", "b"));
  await b;
  pending[0].reject(new Error("stale failure"));
  await a;
  assert.equal(state.snapshot?.workspace.id, "cross");
  assert.equal(state.snapshot?.room.id, "b");
  assert.equal(state.error, "");
});

test("visited room and workspace paint synchronously before refresh resolves", async () => {
  setup("cached");
  const a = selectRoom("cached", "b");
  pending[0].resolve(payload("cached", "b"));
  await a;
  const back = selectRoom("cached", "a");
  assert.equal(state.snapshot?.room.id, "a");
  pending[1].resolve(payload("cached", "a"));
  await back;
  const away = loadWorkspace("away");
  pending[2].resolve(payload("away", "c"));
  await away;
  const home = loadWorkspace("cached");
  assert.equal(state.snapshot?.workspace.id, "cached");
  assert.equal(state.snapshot?.room.id, "a");
  pending[3].resolve(payload("cached", "a"));
  await home;
});

test("closed channel callbacks cannot append foreign events or replace selection", async () => {
  setup("channel");
  connectEvents();
  const old = Channel.all.at(-1)!;
  const next = selectRoom("channel", "b");
  old.emit("room-event", { event: { id: "foreign", text: "wrong room" } });
  assert.deepEqual(state.snapshot?.room.events, []);
  pending[0].resolve(payload("channel", "b"));
  await next;
  old.emit("snapshot", { snapshot: payload("channel", "a").snapshot });
  old.emit("room-event", { event: { id: "foreign" } });
  assert.equal(state.snapshot?.room.id, "b");
  assert.deepEqual(state.snapshot?.room.events, []);
});

test("mismatched snapshot never performs a corrective selection write", () => {
  setup("sticky");
  connectEvents();
  Channel.all.at(-1)!.emit("snapshot", { snapshot: payload("sticky", "b").snapshot });
  assert.equal(state.snapshot?.room.id, "a");
  assert.equal(pending.length, 0);
});

test("resync uses read-only room snapshot, dedupes, and rejects late A→B→A results", async () => {
  setup("resync");
  connectEvents(true);
  const old = Channel.all.at(-1)!;
  old.emit("ready", {});
  old.emit("ready", {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, "/api/workspaces/resync/rooms/a/snapshot");
  assert.equal(pending[0].options.method, undefined);
  const b = selectRoom("resync", "b");
  pending[1].resolve(payload("resync", "b"));
  await b;
  const a = selectRoom("resync", "a");
  pending[2].resolve(payload("resync", "a"));
  await a;
  const stale = payload("resync", "a");
  stale.snapshot.room.events = [{ id: "obsolete" }];
  pending[0].resolve(stale);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(state.snapshot?.room.events, []);
});

test("current fetch failure surfaces error and reconnects the prior room", async () => {
  setup("failure");
  const request = selectRoom("failure", "b");
  pending[0].reject(new Error("network down"));
  await request;
  assert.equal(state.error, "network down");
  assert.equal(state.snapshot?.room.id, "a");
  assert.equal(navigation.pending, false);
  assert.ok(state.eventSource);
});

test("late older-history response cannot contaminate a different workspace with the same room id", async () => {
  setup("older-one");
  state.snapshot!.room.events = [{ id: "first", timestamp: "2026-09-05T10:00:00Z", author: "user", text: "first" }];
  state.older = { roomId: "a", events: [], loading: false, lastTotal: 10 };
  const oldPager = state.older;
  const { loadOlderEvents } = await import("../web/src/transcript.js");
  const older = loadOlderEvents();
  const next = selectRoom("older-two", "a");
  pending[1].resolve(payload("older-two", "a"));
  await next;
  pending[0].resolve({ events: [{ id: "foreign-history", text: "wrong workspace" }] });
  await older;
  assert.equal(state.snapshot?.workspace.id, "older-two");
  assert.deepEqual(state.older.events, []);
  assert.equal(oldPager.loading, false);
});

test("cached older history is discarded when the refreshed transcript was rewound", async () => {
  setup("rewind");
  state.snapshot!.room.eventTotal = 20;
  state.older = { roomId: "a", events: [{ id: "rewound" } as any], loading: true, lastTotal: 20 };
  const b = selectRoom("rewind", "b");
  pending[0].resolve(payload("rewind", "b"));
  await b;
  const a = selectRoom("rewind", "a");
  assert.equal(state.older.loading, false);
  assert.equal(state.older.events.length, 1);
  pending[1].resolve(payload("rewind", "a"));
  await a;
  assert.deepEqual(state.older.events, []);
});

test("room-scoped resync without voice metadata preserves the active call", async () => {
  setup("voice");
  state.voice = { roomId: "a" } as any;
  connectEvents(true);
  Channel.all.at(-1)!.emit("ready", {});
  pending[0].resolve({ snapshot: payload("voice", "a").snapshot });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.voice?.roomId, "a");
});

test("rejected cached navigation rolls back room, workspace, pager and active voice", async () => {
  setup("rollback");
  const b = selectRoom("rollback", "b");
  pending[0].resolve(payload("rollback", "b"));
  await b;
  state.voice = { roomId: "b" } as any;
  const a = selectRoom("rollback", "a");
  assert.equal(state.snapshot?.room.id, "b", "known active-call rejection must not paint cached a");
  pending[1].reject(new Error("Stop the active voice call before switching rooms."));
  await a;
  assert.equal(state.snapshot?.room.id, "b");
  assert.equal(state.voice?.roomId, "b");
  assert.equal(state.older.roomId, "b");
  assert.match(state.error, /active voice call/);
  assert.match(Channel.all.at(-1)!.url, /roomId=b/);
});

test("failed optimistic chain rolls back to last confirmed room, not another unconfirmed cache", async () => {
  setup("chain");
  navigation.save(cached("chain", "b"));
  navigation.save(cached("chain", "c"));
  const b = selectRoom("chain", "b");
  assert.equal(state.snapshot?.room.id, "b");
  const c = selectRoom("chain", "c");
  assert.equal(state.snapshot?.room.id, "c");
  pending[1].reject(new Error("unavailable"));
  await c;
  pending[0].reject(new Error("stale error"));
  await b;
  assert.equal(state.snapshot?.room.id, "a");
  assert.equal(state.error, "unavailable");
});

test("uncached failure after optimistic navigation restores last confirmed selection", async () => {
  setup("uncached-chain");
  navigation.save(cached("uncached-chain", "b"));
  const b = selectRoom("uncached-chain", "b");
  assert.equal(state.snapshot?.room.id, "b");
  const c = selectRoom("uncached-chain", "c");
  pending[1].reject(new Error("unavailable"));
  await c;
  pending[0].resolve(payload("uncached-chain", "b"));
  await b;
  assert.equal(state.snapshot?.room.id, "a");
  assert.equal(state.older.roomId, "a");
  assert.match(Channel.all.at(-1)!.url, /roomId=a/);
});

test("request deadline aborts a stuck navigation fetch", async () => {
  const nav = createNavigation({ timeoutMs: 10 });
  const request = nav.begin();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(request.signal.aborted, true);
  assert.equal(request.signal.reason.name, "TimeoutError");
  nav.finish(request.id);
  assert.equal(nav.pending, false);
});

test("sidebar current-room click cancels a pending departure instead of trusting stale rendered isCurrent", async () => {
  setup("sidebar");
  const { roomIsSelected } = await import("../web/src/sidebar.js");
  assert.equal(roomIsSelected("sidebar", "a"), true);
  assert.equal(roomIsSelected("other", "a"), false);
  const away = selectRoom("sidebar", "b");
  assert.equal(state.snapshot?.room.id, "a");
  assert.equal(roomIsSelected("sidebar", "a"), false, "click must issue a new intent while departure is pending");
  const back = selectRoom("sidebar", "a");
  pending[1].resolve(payload("sidebar", "a"));
  await back;
  pending[0].resolve(payload("sidebar", "b"));
  await away;
  assert.equal(roomIsSelected("sidebar", "a"), true);
});
