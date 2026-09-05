/** @typedef {import("./types.js").SnapshotPayload & {
 * streams: Map<string, import("./types.js").StreamEntry>,
 * older: import("./state.js").state["older"]
 * }} CachedRoom */

/** Latest intent + bounded session-only LRU; never persisted (incognito safe).
 * @param {{ maxEntries?: number, timeoutMs?: number }} [options] */
export function createNavigation({ maxEntries = 12, timeoutMs = 15000 } = {}) {
  /** @type {Map<string, CachedRoom>} */
  const cache = new Map();
  /** @type {Map<string, string>} */
  const lastRooms = new Map();
  /** @type {AbortController|null} */
  let controller = null;
  let generation = 0;
  let pending = false;
  /** @param {string} workspaceId @param {string} roomId */
  const key = (workspaceId, roomId) => JSON.stringify([workspaceId, roomId]);
  return {
    get timeoutMs() { return timeoutMs; },
    get generation() { return generation; },
    get pending() { return pending; },
    begin() {
      controller?.abort();
      controller = new AbortController();
      pending = true;
      const id = ++generation;
      return { id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) };
    },
    /** @param {number} id */
    current(id) { return generation === id; },
    /** @param {number} id */
    finish(id) { if (generation === id) pending = false; },
    /** @param {CachedRoom} entry */
    save(entry) {
      const { workspace, room } = entry.snapshot;
      const id = key(workspace.id, room.id);
      cache.delete(id);
      cache.set(id, entry);
      lastRooms.set(workspace.id, room.id);
      while (cache.size > Math.max(1, maxEntries)) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    },
    /** @param {string} workspaceId @param {string} [roomId] */
    get(workspaceId, roomId = lastRooms.get(workspaceId)) {
      if (!roomId) return undefined;
      const id = key(workspaceId, roomId);
      const entry = cache.get(id);
      if (entry) { cache.delete(id); cache.set(id, entry); }
      return entry;
    },
    /** @param {string} workspaceId @param {string} [roomId] */
    forget(workspaceId, roomId) {
      for (const [id, entry] of cache) {
        if (entry.snapshot.workspace.id === workspaceId && (!roomId || entry.snapshot.room.id === roomId)) cache.delete(id);
      }
      if (!roomId || lastRooms.get(workspaceId) === roomId) lastRooms.delete(workspaceId);
    },
  };
}

export const navigation = createNavigation();
