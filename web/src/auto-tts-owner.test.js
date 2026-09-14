// @ts-nocheck — deterministic Web Locks, Storage, clock, and timer doubles.
import { expect, test } from "bun:test";
import { AutoTtsOwner } from "./auto-tts-owner.js";

class MemoryStorage {
  values = new Map();
  failGet = false;
  failSet = false;
  getItem(key) {
    if (this.failGet) throw new Error("get blocked");
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    if (this.failSet) throw new Error("set blocked");
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

class LockManagerDouble {
  held = false;
  requests = 0;
  request(_name, options, callback) {
    this.requests++;
    expect(options).toEqual({ ifAvailable: true });
    if (this.held) return Promise.resolve(callback(null));
    this.held = true;
    return Promise.resolve(callback({ name: "gaia-auto-tts" })).finally(() => { this.held = false; });
  }
}

function timerDouble() {
  let next = 1;
  const intervals = new Map();
  return {
    setInterval(callback) { const id = next++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { callback(); return next++; },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    count() { return intervals.size; },
  };
}

function leaseOptions(storage, target, timers, now, id, onLost = () => {}) {
  return {
    navigator: {}, storage, eventTarget: target,
    now: () => now.value, makeId: () => id, onLost,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    timings: { leaseMs: 100, heartbeatMs: 25, arbitrationMs: 0 },
  };
}

function leaseRecord(storage) {
  const raw = [...storage.values.values()][0];
  return raw ? JSON.parse(raw) : null;
}

function emitStorage(target) {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: "gaia-auto-tts-owner" });
  target.dispatchEvent(event);
}

const turn = () => new Promise((resolve) => queueMicrotask(resolve));

test("Web Locks grants one owner and denies another without waiting for release", async () => {
  const locks = new LockManagerDouble();
  const first = new AutoTtsOwner({ navigator: { locks }, makeId: () => "first" });
  const second = new AutoTtsOwner({ navigator: { locks }, makeId: () => "second" });

  expect(await first.acquire()).toBe(true);
  expect(first.owns()).toBe(true);
  expect(await second.acquire()).toBe(false);
  expect(second.owns()).toBe(false);
  expect(locks.held).toBe(true);

  first.dispose();
  await turn();
  second.dispose();
});

test("Web Lock release allows reacquire", async () => {
  const locks = new LockManagerDouble();
  const first = new AutoTtsOwner({ navigator: { locks } });
  const second = new AutoTtsOwner({ navigator: { locks } });
  expect(await first.acquire()).toBe(true);
  first.dispose();
  await turn();
  expect(await second.acquire()).toBe(true);
  second.dispose();
  await turn();
  expect(locks.held).toBe(false);
});

test("concurrent acquire calls share arbitration and do not await held-lock release", async () => {
  const locks = new LockManagerDouble();
  const owner = new AutoTtsOwner({ navigator: { locks } });
  const first = owner.acquire();
  const second = owner.acquire();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(locks.requests).toBe(1);
  expect(owner.owns()).toBe(true);
  owner.dispose();
});

test("fallback lease heartbeat renews expiry", async () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  const timers = timerDouble();
  const now = { value: 1_000 };
  const owner = new AutoTtsOwner(leaseOptions(storage, target, timers, now, "owner"));

  expect(await owner.acquire()).toBe(true);
  expect(leaseRecord(storage)).toEqual({ owner: "owner", expiresAt: 1_100 });
  now.value = 1_025;
  timers.tick();
  expect(leaseRecord(storage)).toEqual({ owner: "owner", expiresAt: 1_125 });
  expect(owner.owns()).toBe(true);
  owner.dispose();
  expect(leaseRecord(storage)).toBeNull();
  expect(timers.count()).toBe(0);
});

test("expired fallback lease is lost and another owner recovers it", async () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  const timers = timerDouble();
  const now = { value: 10 };
  let losses = 0;
  const first = new AutoTtsOwner(leaseOptions(storage, target, timers, now, "first", () => losses++));
  expect(await first.acquire()).toBe(true);

  now.value = 111;
  expect(first.owns()).toBe(false);
  expect(losses).toBe(1);
  const second = new AutoTtsOwner(leaseOptions(storage, target, timers, now, "second"));
  expect(await second.acquire()).toBe(true);
  expect(second.owns()).toBe(true);
  second.dispose();
  first.dispose();
});

test("fallback conflict event revokes ownership and reports loss once", async () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  const timers = timerDouble();
  const now = { value: 50 };
  let losses = 0;
  const owner = new AutoTtsOwner(leaseOptions(storage, target, timers, now, "owner", () => losses++));
  expect(await owner.acquire()).toBe(true);

  storage.setItem("gaia-auto-tts-owner", JSON.stringify({ owner: "rival", expiresAt: 500 }));
  emitStorage(target);
  emitStorage(target);
  expect(owner.owns()).toBe(false);
  expect(losses).toBe(1);
  expect(timers.count()).toBe(0);
  owner.dispose();
});

test("fallback arbitration permits only the verified lease writer", async () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  const timers = timerDouble();
  const now = { value: 0 };
  const queued = [];
  const options = (id) => ({
    ...leaseOptions(storage, target, timers, now, id),
    setTimeout(callback) { queued.push(callback); return queued.length; },
  });
  const first = new AutoTtsOwner(options("first"));
  const second = new AutoTtsOwner(options("second"));
  const a = first.acquire();
  const b = second.acquire();
  for (const callback of queued) callback();
  expect(await Promise.all([a, b])).toEqual([true, false]);
  expect(first.owns()).toBe(true);
  expect(second.owns()).toBe(false);
  first.dispose();
  second.dispose();
});

test("storage failures fail closed during acquire and validation", async () => {
  const target = new EventTarget();
  const timers = timerDouble();
  const now = { value: 0 };
  const blocked = new MemoryStorage();
  blocked.failSet = true;
  const denied = new AutoTtsOwner(leaseOptions(blocked, target, timers, now, "denied"));
  expect(await denied.acquire()).toBe(false);
  expect(denied.owns()).toBe(false);

  const storage = new MemoryStorage();
  let losses = 0;
  const owner = new AutoTtsOwner(leaseOptions(storage, target, timers, now, "owner", () => losses++));
  expect(await owner.acquire()).toBe(true);
  storage.failGet = true;
  expect(owner.owns()).toBe(false);
  expect(losses).toBe(1);
  owner.dispose();
  denied.dispose();
});
