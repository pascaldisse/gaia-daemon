// Read-aloud: the per-message play button. Two playback paths, chosen by the
// server (never by engine id here):
//   • stream — the desktop-app path. The server synthesizes the WHOLE message
//     as one continuous PCM pass; we play it frame-by-frame through the Web
//     Audio API, scheduling each frame sample-accurately after the last, so the
//     first audio starts the instant the first frame lands and there are no
//     seams. Used by streaming engines (claude-voice).
//   • chunks — the batch path (local TTS). The server splits the message into
//     sentence chunks and synthesizes them on demand (cached on disk); we fetch
//     them one after the other and play them back-to-back, prefetching the next
//     while the current one speaks. Fetched chunk audio is kept per message so
//     replaying is instant and free.
// The server advertises the mode; this module dispatches on it, so no engine id
// ever reaches the client.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

/**
 * The batch (chunk) playback run. `stopped` flips on stop/restart so late
 * fetches and `onended` callbacks from an abandoned session never touch state.
 * @typedef {Object} ChunkSession
 * @property {"chunk"} kind
 * @property {string} eventId
 * @property {{workspaceId: string, roomId: string}} origin room the message lives in
 * @property {number} total
 * @property {(string|undefined)[]} urls
 * @property {Map<number, Promise<string>>} pending
 * @property {AbortController[]} controllers
 * @property {HTMLAudioElement|null} audio
 * @property {boolean} stopped
 */

/**
 * The streaming playback run. `stopped` flips on stop/restart; teardown aborts
 * the fetch, stops every scheduled source, and closes the AudioContext.
 * @typedef {Object} StreamSession
 * @property {"stream"} kind
 * @property {string} eventId
 * @property {{workspaceId: string, roomId: string}} origin room the message lives in
 * @property {boolean} stopped
 * @property {AbortController} controller
 * @property {AudioContext|null} ctx
 * @property {AudioBufferSourceNode[]} sources
 */

/** @type {ChunkSession|StreamSession|null} */
let session = null;

/** Fetched chunk audio per message (object URLs), so batch replays skip the
 * server entirely. Small LRU: URLs are revoked when a message is evicted. */
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
    if (current.kind === "stream") {
      try {
        current.controller.abort();
      } catch {
        // Fetch already settled.
      }
      for (const src of current.sources) {
        try {
          src.stop();
        } catch {
          // Not started / already stopped.
        }
      }
      if (current.ctx) void current.ctx.close().catch(() => {});
    } else {
      for (const controller of current.controllers) controller.abort();
      current.audio?.pause();
      rememberAudio(current);
    }
  }
  if (state.readAloud) {
    state.readAloud = null;
    markDirty("transcript", "status");
  }
}

/** @param {string} eventId */
async function startReadAloud(eventId) {
  stopReadAloud();
  const snapshot = state.snapshot;
  if (!snapshot) return;

  const base = `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}`;
  const chunkEndpoint = `${base}/read-aloud`;
  // Bind this playback to the room it started in — the endpoints are captured
  // here, so switching rooms mid-playback never re-points fetches, and the
  // now-playing chip can jump back to this exact room+message.
  const origin = { workspaceId: snapshot.workspace.id, roomId: snapshot.room.id };

  // Instant replay of a message we already streamed chunk audio for (batch path).
  if (audioCache.has(eventId)) {
    await runChunkSession(eventId, chunkEndpoint, origin);
    return;
  }

  // Ask the server how to speak this message. A streaming engine answers with a
  // continuous PCM stream; a batch engine answers {mode:"chunks"} and we fall
  // back to the per-chunk path below.
  const controller = new AbortController();
  /** @type {StreamSession} */
  const stream = { kind: "stream", eventId, origin, stopped: false, controller, ctx: null, sources: [] };
  session = stream;
  state.readAloud = { eventId, phase: "loading", ...origin };
  markDirty("transcript", "status");

  try {
    const response = await fetch(`${base}/read-aloud/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId }),
      signal: controller.signal,
    });
    if (stream.stopped) return;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Read aloud failed: ${response.status}`);
    }
    if (response.headers.get("x-tts-mode") === "stream" && response.body) {
      await playPcmStream(stream, response);
      return;
    }
    // Batch engine: hand off to the unchanged per-chunk path.
    const info = await response.json().catch(() => ({}));
    const total = Number.isInteger(info?.chunks) && info.chunks > 0 ? info.chunks : undefined;
    await runChunkSession(eventId, chunkEndpoint, origin, total);
  } catch (error) {
    if (stream.stopped) return;
    stopReadAloud();
    if (!(error instanceof DOMException && error.name === "AbortError")) setError(error);
  }
}

/**
 * Play a continuous PCM stream frame-by-frame through the Web Audio API,
 * scheduling each decoded frame to start exactly where the previous one ends —
 * so playback is gapless and starts as soon as the first frame arrives.
 * @param {StreamSession} current
 * @param {Response} response
 */
async function playPcmStream(current, response) {
  const rate = Number(response.headers.get("x-tts-rate")) || 16000;
  const channels = Number(response.headers.get("x-tts-channels")) || 1;
  const ctx = new AudioContext();
  current.ctx = ctx;
  try {
    await ctx.resume();
  } catch {
    // A suspended context still schedules; it resumes on the next gesture.
  }

  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const frameBytes = 2 * channels; // s16le
  /** @type {Uint8Array} */
  let leftover = new Uint8Array(0);
  let nextTime = 0;
  let started = false;
  /** @type {AudioBufferSourceNode|null} */
  let lastSource = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (current.stopped) {
      try {
        await reader.cancel();
      } catch {
        // Already cancelled.
      }
      return;
    }
    if (done) break;
    if (!value || value.length === 0) continue;

    // A read may split a sample across HTTP frames; carry the remainder.
    let buf = value;
    if (leftover.length) {
      const merged = new Uint8Array(leftover.length + value.length);
      merged.set(leftover);
      merged.set(value, leftover.length);
      buf = merged;
      leftover = new Uint8Array(0);
    }
    const usable = buf.length - (buf.length % frameBytes);
    if (usable < buf.length) leftover = buf.slice(usable);
    if (usable === 0) continue;

    const frameCount = usable / frameBytes;
    const audioBuf = ctx.createBuffer(channels, frameCount, rate);
    const view = new DataView(buf.buffer, buf.byteOffset, usable);
    for (let ch = 0; ch < channels; ch++) {
      const out = audioBuf.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) out[i] = view.getInt16((i * channels + ch) * 2, true) / 32768;
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    // Small lead on the first frame absorbs scheduling jitter; after that each
    // frame butts directly against the previous one (sample-accurate, no gap).
    if (nextTime < ctx.currentTime + 0.02) nextTime = ctx.currentTime + 0.12;
    src.start(nextTime);
    nextTime += audioBuf.duration;
    lastSource = src;
    current.sources.push(src);

    if (!started) {
      started = true;
      if (state.readAloud?.eventId === current.eventId && state.readAloud.phase !== "playing") {
        state.readAloud = { eventId: current.eventId, phase: "playing", ...current.origin };
        markDirty("transcript", "status");
      }
    }
  }

  // Let the queued audio finish before tearing the context down.
  if (!current.stopped && lastSource) {
    await new Promise((resolve) => {
      /** @type {AudioBufferSourceNode} */ (lastSource).onended = () => resolve(undefined);
    });
  }
  if (!current.stopped) stopReadAloud();
}

/**
 * The batch (chunk) playback path: fetch each chunk WAV in turn and play it,
 * prefetching the next while the current speaks.
 * @param {string} eventId
 * @param {string} endpoint
 * @param {{workspaceId: string, roomId: string}} origin room the message lives in
 * @param {number} [knownTotal] chunk count from the mode probe, if known
 */
async function runChunkSession(eventId, endpoint, origin, knownTotal) {
  const cached = audioCache.get(eventId);
  /** @type {ChunkSession} */
  const current = {
    kind: "chunk",
    eventId,
    origin,
    total: cached?.total ?? knownTotal ?? Number.POSITIVE_INFINITY,
    urls: cached ? [...cached.urls] : [],
    pending: new Map(),
    controllers: [],
    audio: null,
    stopped: false,
  };
  session = current;
  state.readAloud = { eventId, phase: current.urls[0] ? "playing" : "loading", ...origin };
  markDirty("transcript", "status");

  try {
    for (let index = 0; index < current.total && !current.stopped; index++) {
      const url = await fetchChunk(current, endpoint, index);
      if (current.stopped) return;
      // The next chunk downloads/synthesizes while this one speaks.
      if (index + 1 < current.total) void fetchChunk(current, endpoint, index + 1).catch(() => {});
      if (state.readAloud?.eventId === eventId && state.readAloud.phase !== "playing") {
        state.readAloud = { eventId, phase: "playing", ...origin };
        markDirty("transcript", "status");
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
 * @param {ChunkSession} current
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
 * @param {ChunkSession} current
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
 * @param {ChunkSession} current */
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
