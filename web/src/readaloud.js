// Read-aloud: the per-message play button. The server splits a message into
// sentence chunks and synthesizes them on demand (cached on disk); this module
// fetches the chunks one after the other and plays them back-to-back, always
// prefetching the next chunk while the current one speaks — so long messages
// start quickly and never depend on one giant fragile request. Fetched chunk
// audio is kept per message, so replaying is instant and free.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

/**
 * One playback run. `stopped` flips on stop/restart so late fetches and
 * `onended` callbacks from an abandoned session never touch the UI state.
 * @typedef {Object} ReadAloudSession
 * @property {string} eventId
 * @property {number} total
 * @property {(string|undefined)[]} urls
 * @property {Map<number, Promise<string>>} pending
 * @property {AbortController[]} controllers
 * @property {HTMLAudioElement|null} audio
 * @property {boolean} stopped
 */

/** @type {ReadAloudSession|null} */
let session = null;

/** Fetched chunk audio per message (object URLs), so replays skip the server
 * entirely. Small LRU: URLs are revoked when a message is evicted. */
const MAX_CACHED_MESSAGES = 8;
/** @type {Map<string, { urls: (string|undefined)[], total: number }>} */
const audioCache = new Map();

/** @param {string} eventId */
export function toggleReadAloud(eventId) {
  if (state.readAloud?.eventId === eventId) {
    stopReadAloud();
    return;
  }
  void startReadAloud(eventId);
}

export function stopReadAloud() {
  const current = session;
  session = null;
  if (current) {
    current.stopped = true;
    for (const controller of current.controllers) controller.abort();
    current.audio?.pause();
    rememberAudio(current);
  }
  if (state.readAloud) {
    state.readAloud = null;
    markDirty("transcript");
  }
}

/** @param {string} eventId */
async function startReadAloud(eventId) {
  stopReadAloud();
  const snapshot = state.snapshot;
  if (!snapshot) return;

  const cached = audioCache.get(eventId);
  /** @type {ReadAloudSession} */
  const current = {
    eventId,
    total: cached?.total ?? Number.POSITIVE_INFINITY,
    urls: cached ? [...cached.urls] : [],
    pending: new Map(),
    controllers: [],
    audio: null,
    stopped: false,
  };
  session = current;
  state.readAloud = { eventId, phase: current.urls[0] ? "playing" : "loading" };
  markDirty("transcript");

  const endpoint = `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/read-aloud`;
  try {
    for (let index = 0; index < current.total && !current.stopped; index++) {
      const url = await fetchChunk(current, endpoint, index);
      if (current.stopped) return;
      // The next chunk downloads/synthesizes while this one speaks.
      if (index + 1 < current.total) void fetchChunk(current, endpoint, index + 1).catch(() => {});
      if (state.readAloud?.eventId === eventId && state.readAloud.phase !== "playing") {
        state.readAloud = { eventId, phase: "playing" };
        markDirty("transcript");
      }
      await playUrl(current, url);
    }
    if (!current.stopped) stopReadAloud();
  } catch (error) {
    if (current.stopped) return;
    stopReadAloud();
    if (!(error instanceof DOMException && error.name === "AbortError")) setError(error);
  }
}

/**
 * Chunk audio as an object URL — from this session, the message cache, or the
 * server. Deduped so play-loop and prefetch never race the same chunk.
 * @param {ReadAloudSession} current
 * @param {string} endpoint
 * @param {number} index
 * @returns {Promise<string>}
 */
function fetchChunk(current, endpoint, index) {
  const existing = current.urls[index];
  if (existing) return Promise.resolve(existing);
  const pending = current.pending.get(index);
  if (pending) return pending;

  const controller = new AbortController();
  current.controllers.push(controller);
  const promise = (async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: current.eventId, chunk: index }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Read aloud failed: ${response.status}`);
    }
    const total = Number(response.headers.get("x-tts-chunks"));
    if (Number.isInteger(total) && total > 0) current.total = total;
    const url = URL.createObjectURL(await response.blob());
    current.urls[index] = url;
    return url;
  })();
  current.pending.set(index, promise);
  return promise;
}

/**
 * @param {ReadAloudSession} current
 * @param {string} url
 * @returns {Promise<void>}
 */
function playUrl(current, url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    current.audio = audio;
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Read aloud: could not play the returned audio."));
    audio.play().catch(reject);
  });
}

/** Keep a finished/stopped session's chunk audio for instant replay.
 * @param {ReadAloudSession} current */
function rememberAudio(current) {
  if (!current.urls.some(Boolean)) return;
  const total = Number.isFinite(current.total) ? current.total : current.urls.length;
  audioCache.delete(current.eventId);
  audioCache.set(current.eventId, { urls: current.urls, total });
  for (const [eventId, entry] of audioCache) {
    if (audioCache.size <= MAX_CACHED_MESSAGES) break;
    for (const url of entry.urls) {
      if (url) URL.revokeObjectURL(url);
    }
    audioCache.delete(eventId);
  }
}
