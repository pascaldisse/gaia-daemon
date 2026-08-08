// Read-aloud: the per-message play button + the mini audio player above the
// composer. Two things live here:
//
//   1. AudioTransport — a seekable, progressive PCM player. Both server modes
//      (continuous "stream" PCM, or batch "chunks" WAVs) DECODE INTO ONE growing
//      mono buffer, so playback has a single timeline: play/pause, seek anywhere,
//      currentTime + duration. Playback starts the instant the first audio lands
//      (low latency, like before) and the buffer keeps filling behind the
//      playhead, so you can scrub while it is still arriving. When a message
//      finishes we keep its whole PCM (client cache) so a replay is instant and
//      fully seekable with no server round-trip.
//
//   2. The mini player UI — a play/pause button, a clickable + draggable
//      timeline with a thumb, and current/total time, rendered above the running
//      banner. It is driven by a rAF loop while playing and by discrete repaints
//      otherwise. The server still decides the mode; nothing here branches on an
//      engine id (same law as the harness abstraction).
import { markDirty, setError } from "./render.js";
import { h } from "./dom.js";
import { state } from "./state.js";

/** @typedef {"loading"|"playing"|"paused"|"ended"} ReadAloudPhase */

// ---------------------------------------------------------------------------
// The transport. Owns one AudioContext and a growing list of mono PCM segments;
// schedules Web Audio buffer sources from the play frontier and re-anchors on
// underrun so the playhead clock stays honest.

class AudioTransport {
  constructor() {
    /** @type {AudioContext} */
    this.ctx = new AudioContext();
    /** Engine sample rate; buffers are created at it and Web Audio resamples to
     * the context on playback. 0 until the first audio sets the format. */
    this.rate = 0;
    /** @type {Float32Array[]} mono PCM segments in arrival order */
    this.segments = [];
    /** @type {number[]} cumulative sample index at each segment's start */
    this.segStart = [];
    /** Total samples appended so far (grows while streaming). */
    this.total = 0;
    /** No more audio will arrive (stream ended / all chunks decoded). */
    this.done = false;
    /** True between play() and pause()/finish. */
    this.playing = false;
    /** ctx.currentTime the current play run was anchored at. */
    this.anchorCtx = 0;
    /** The sample index that anchorCtx corresponds to. */
    this.anchorSample = 0;
    /** Next sample to schedule (the play frontier). */
    this.frontier = 0;
    /** Playhead while paused, in samples. */
    this.pausedSample = 0;
    /** @type {Set<AudioBufferSourceNode>} scheduled, not-yet-ended sources */
    this.sources = new Set();
    this.firstAudioSeen = false;
    /** Guards migrateContext() against overlapping device-change events. */
    this._migrating = false;
    /** @type {(() => void)|null} fired once when the first source is scheduled */
    this.onFirstAudio = null;
    /** @type {(() => void)|null} fired when the last sample finishes playing */
    this.onEnded = null;
  }

  /** @returns {number} */
  get sampleRate() {
    return this.rate || 16000;
  }

  /** Available (buffered) duration in seconds — grows while streaming. */
  get duration() {
    return this.total / this.sampleRate;
  }

  /** Current playhead in seconds, clamped to what is buffered. */
  get currentTime() {
    if (!this.playing) return this.pausedSample / this.sampleRate;
    const s = this.anchorSample + (this.ctx.currentTime - this.anchorCtx) * this.sampleRate;
    return Math.min(this.total, Math.max(0, s)) / this.sampleRate;
  }

  /** @param {number} rate @param {number} _channels */
  setFormat(rate, _channels) {
    if (!this.rate && rate > 0) this.rate = rate;
  }

  /** Append a mono PCM segment; schedule it if we are playing.
   * @param {Float32Array} mono */
  append(mono) {
    if (!mono.length) return;
    this.segStart.push(this.total);
    this.segments.push(mono);
    this.total += mono.length;
    if (this.playing) this._pump();
  }

  /** Read samples [from, to) into one contiguous Float32Array (across segments).
   * @param {number} from @param {number} to @returns {Float32Array} */
  _read(from, to) {
    const out = new Float32Array(Math.max(0, to - from));
    let oi = 0;
    for (let i = 0; i < this.segments.length && oi < out.length; i++) {
      const segA = this.segStart[i];
      const seg = this.segments[i];
      const segB = segA + seg.length;
      if (segB <= from) continue;
      if (segA >= to) break;
      const a = Math.max(from, segA) - segA;
      const b = Math.min(to, segB) - segA;
      out.set(seg.subarray(a, b), oi);
      oi += b - a;
    }
    return out;
  }

  /** Schedule every buffered-but-unscheduled sample ahead of the playhead. */
  _pump() {
    while (this.frontier < this.total) {
      const start = this.frontier;
      const end = this.total;
      let startCtx = this.anchorCtx + (start - this.anchorSample) / this.sampleRate;
      // First schedule or an underrun (playback caught the download): re-anchor
      // a hair in the future so the clock and the audio agree again.
      if (startCtx < this.ctx.currentTime + 0.02) {
        startCtx = this.ctx.currentTime + 0.08;
        this.anchorCtx = startCtx;
        this.anchorSample = start;
      }
      const buf = this.ctx.createBuffer(1, end - start, this.sampleRate);
      buf.getChannelData(0).set(this._read(start, end));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(startCtx);
      this.frontier = end;
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        this._maybeFinish();
      };
    }
    if (!this.firstAudioSeen && this.sources.size) {
      this.firstAudioSeen = true;
      this.onFirstAudio?.();
    }
  }

  _maybeFinish() {
    if (this.playing && this.done && this.frontier >= this.total && this.sources.size === 0) {
      this.playing = false;
      this.pausedSample = this.total;
      this.onEnded?.();
    }
  }

  /** Start (or resume/seek) playback from a sample index.
   * @param {number} [fromSample] defaults to the current playhead */
  play(fromSample) {
    const from = fromSample ?? Math.round(this.currentTime * this.sampleRate);
    this._stopSources();
    this.playing = true;
    this.frontier = Math.min(Math.max(0, from), this.total);
    this.anchorCtx = this.ctx.currentTime + 0.08;
    this.anchorSample = this.frontier;
    void this.ctx.resume().catch(() => {});
    this._pump();
    this._maybeFinish();
  }

  pause() {
    if (!this.playing) return;
    this.pausedSample = Math.round(this.currentTime * this.sampleRate);
    this._stopSources();
    this.playing = false;
  }

  /** @param {number} seconds */
  seek(seconds) {
    const sample = Math.max(0, Math.min(this.total, Math.round(seconds * this.sampleRate)));
    if (this.playing) this.play(sample);
    else this.pausedSample = sample;
  }

  markDone() {
    this.done = true;
    this._maybeFinish();
  }

  _stopSources() {
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Not started / already stopped.
      }
    }
    this.sources.clear();
  }

  /** Re-bind playback to the CURRENT default output device.
   *
   * An AudioContext latches onto whatever output was default when it was
   * created. Chromium silently follows a later default-device change; WebKit
   * (the macOS/iOS native shell) does NOT — if the bound device disappears
   * mid-playback (e.g. Bluetooth headphones disconnect), the context keeps
   * ticking ctx.currentTime into a dead route: the timeline advances, the
   * playhead moves, and there is no sound. We recreate the context so it
   * re-binds to the live default, resuming from the current playhead. The
   * buffered PCM (this.segments) survives — only the ctx + scheduled sources
   * are rebuilt. No-op unless we are actually playing. */
  async migrateContext() {
    if (!this.playing || this._migrating) return;
    this._migrating = true;
    try {
      const resumeAt = Math.round(this.currentTime * this.sampleRate);
      this._stopSources();
      try {
        await this.ctx.close();
      } catch {
        // Already closed.
      }
      this.ctx = new AudioContext();
      this.play(resumeAt);
    } finally {
      this._migrating = false;
    }
  }

  destroy() {
    this._stopSources();
    void this.ctx.close().catch(() => {});
  }

  /** The whole buffered PCM as one Float32Array (for the client cache). */
  concatPcm() {
    return this._read(0, this.total);
  }
}

// ---------------------------------------------------------------------------
// Module playback state: at most one message plays at a time (this tab).

/** @type {AudioTransport|null} */
let transport = null;
/** @type {AbortController|null} */
let fetchController = null;
let activeEventId = "";
/** @type {{workspaceId: string, roomId: string}|null} */
let activeOrigin = null;

// When the set of audio devices changes (headphones plugged/unplugged, a
// Bluetooth output vanishes), re-bind the playing transport to the new default
// output. Harness-agnostic: matters on WebKit (the native shell) where a
// context does not follow the default device on its own, harmless on Chromium
// where it already does. Registered once; fires only while something plays.
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void transport?.migrateContext();
});

/** Whole-message PCM kept after a clean finish, so replays are instant and
 * fully seekable without touching the server. Small LRU by message. */
const MAX_CACHED_MESSAGES = 8;
/** @type {Map<string, { pcm: Float32Array, rate: number }>} */
const pcmCache = new Map();

/** @param {ReadAloudPhase} phase */
function setPhase(phase) {
  if (state.readAloud?.eventId === activeEventId && activeOrigin) {
    state.readAloud = { eventId: activeEventId, phase, ...activeOrigin };
  }
  markDirty("transcript", "status");
}

/** Toggle read-aloud for a message: start it, or if it is already the active
 * one, toggle play/pause (during loading, cancel it).
 * @param {string} eventId */
export function toggleReadAloud(eventId) {
  if (activeEventId === eventId && transport) {
    if (state.readAloud?.phase === "loading") stopReadAloud();
    else playerToggle();
    return;
  }
  void startReadAloud(eventId);
}

/** Tear everything down and hide the player. */
export function stopReadAloud() {
  stopTick();
  if (fetchController) {
    try {
      fetchController.abort();
    } catch {
      // Already settled.
    }
    fetchController = null;
  }
  if (transport) {
    transport.onEnded = null;
    transport.onFirstAudio = null;
    transport.destroy();
    transport = null;
  }
  activeEventId = "";
  activeOrigin = null;
  if (state.readAloud) {
    state.readAloud = null;
    markDirty("transcript", "status");
  }
  updatePlayerUi();
}

/** @param {string} eventId @param {boolean} [regenerate] skip both caches and
 * re-synthesize (the ⟳ button), replacing a bad cached clip. */
async function startReadAloud(eventId, regenerate = false) {
  stopReadAloud();
  const snapshot = state.snapshot;
  if (!snapshot) return;

  const base = `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}`;
  // Bind playback to the room it started in, so switching rooms mid-play never
  // re-points fetches and the now-playing chip can jump back to this message.
  const origin = { workspaceId: snapshot.workspace.id, roomId: snapshot.room.id };
  activeEventId = eventId;
  activeOrigin = origin;

  const t = new AudioTransport();
  transport = t;
  t.onFirstAudio = () => {
    if (activeEventId === eventId && state.readAloud?.phase === "loading") setPhase("playing");
  };
  t.onEnded = () => {
    stopTick();
    if (activeEventId === eventId) setPhase("ended");
    rememberPcm(eventId, t);
    updatePlayerUi();
  };

  state.readAloud = { eventId, phase: "loading", ...origin };
  markDirty("transcript", "status");

  // Instant, fully-seekable replay from the client PCM cache (skipped on regen).
  const cached = regenerate ? undefined : pcmCache.get(eventId);
  if (cached) {
    t.setFormat(cached.rate, 1);
    t.append(cached.pcm.slice());
    t.markDone();
    t.play(0);
    setPhase("playing");
    startTick();
    return;
  }

  const controller = new AbortController();
  fetchController = controller;
  t.play(0); // arm the transport; audio schedules as soon as the first bytes land
  startTick();

  try {
    const response = await fetch(`${base}/read-aloud/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, ...(regenerate ? { regenerate: true } : {}) }),
      signal: controller.signal,
    });
    if (transport !== t) return; // stopped/replaced while awaiting
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Read aloud failed: ${response.status}`);
    }
    if (response.headers.get("x-tts-mode") === "stream" && response.body) {
      await feedStream(t, response, controller);
    } else {
      const info = await response.json().catch(() => ({}));
      const total = Number.isInteger(info?.chunks) && info.chunks > 0 ? info.chunks : 1;
      await feedChunks(t, base, eventId, total, controller, regenerate);
    }
  } catch (error) {
    if (transport !== t || controller.signal.aborted) return;
    stopReadAloud();
    if (!(error instanceof DOMException && error.name === "AbortError")) setError(error);
  }
}

/** Continuous PCM: decode each s16le frame to mono and append as it arrives.
 * @param {AudioTransport} t @param {Response} response @param {AbortController} controller */
async function feedStream(t, response, controller) {
  const rate = Number(response.headers.get("x-tts-rate")) || 16000;
  const channels = Number(response.headers.get("x-tts-channels")) || 1;
  t.setFormat(rate, channels);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const frameBytes = 2 * channels; // s16le
  /** @type {Uint8Array} */
  let leftover = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (controller.signal.aborted || transport !== t) {
      try {
        await reader.cancel();
      } catch {
        // Already cancelled.
      }
      return;
    }
    if (done) break;
    if (!value || value.length === 0) continue;
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
    t.append(s16leToMono(buf.subarray(0, usable), channels));
  }
  t.markDone();
}

/** Batch WAV chunks: fetch each, decode to PCM, append. append() is
 * non-blocking (it just schedules), so the next chunk fetches while the current
 * one plays — natural pipelining, no explicit prefetch needed.
 * @param {AudioTransport} t @param {string} base @param {string} eventId
 * @param {number} total @param {AbortController} controller @param {boolean} [regenerate] */
async function feedChunks(t, base, eventId, total, controller, regenerate = false) {
  const endpoint = `${base}/read-aloud`;
  for (let index = 0; index < total; index++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, chunk: index, ...(regenerate ? { regenerate: true } : {}) }),
      signal: controller.signal,
    });
    if (controller.signal.aborted || transport !== t) return;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Read aloud failed: ${response.status}`);
    }
    const count = Number(response.headers.get("x-tts-chunks"));
    if (Number.isInteger(count) && count > 0) total = count;
    const decoded = await t.ctx.decodeAudioData(await response.arrayBuffer());
    if (controller.signal.aborted || transport !== t) return;
    t.setFormat(decoded.sampleRate, decoded.numberOfChannels);
    t.append(downmix(decoded));
  }
  t.markDone();
}

/** @param {string} eventId @param {AudioTransport} t */
function rememberPcm(eventId, t) {
  if (!t.total || !t.rate) return;
  pcmCache.delete(eventId);
  pcmCache.set(eventId, { pcm: t.concatPcm(), rate: t.rate });
  for (const key of pcmCache.keys()) {
    if (pcmCache.size <= MAX_CACHED_MESSAGES) break;
    pcmCache.delete(key);
  }
}

/** @param {Uint8Array} bytes whole s16le frames @param {number} channels @returns {Float32Array} */
function s16leToMono(bytes, channels) {
  const frames = Math.floor(bytes.length / (2 * channels));
  const out = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2 * channels);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16((i * channels + c) * 2, true);
    out[i] = sum / channels / 32768;
  }
  return out;
}

/** @param {AudioBuffer} buffer @returns {Float32Array} */
function downmix(buffer) {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= channels;
  return out;
}

// ---------------------------------------------------------------------------
// The mini player UI (built once, mounted in the composer above the banner).

/** @type {HTMLElement|null} */
let playerRoot = null;
/** @type {HTMLButtonElement|null} */
let toggleBtn = null;
/** @type {HTMLElement|null} */
let curTimeEl = null;
/** @type {HTMLElement|null} */
let durTimeEl = null;
/** @type {HTMLElement|null} */
let liveEl = null;
/** @type {HTMLElement|null} */
let trackEl = null;
/** @type {HTMLElement|null} */
let playedEl = null;
/** @type {HTMLElement|null} */
let thumbEl = null;

let rafId = 0;
let dragging = false;
let dragWasPlaying = false;
let dragFrac = 0;

/** Build the player element once. Called by the composer at init. */
export function buildAudioPlayer() {
  playedEl = h("div", { class: "ap-played" });
  thumbEl = h("div", { class: "ap-thumb" });
  trackEl = h("div", { class: "ap-track", title: "click or drag to seek" }, playedEl, thumbEl);
  toggleBtn = /** @type {HTMLButtonElement} */ (
    h("button", { type: "button", class: "ap-toggle", title: "play", text: "▶", onclick: playerToggle })
  );
  curTimeEl = h("span", { class: "ap-time" }, "0:00");
  durTimeEl = h("span", { class: "ap-time ap-dur" }, "0:00");
  // Shown only while the stream is still synthesizing: the total is provisional
  // and grows in real-time (claude-voice generates at ~speaking speed), so this
  // says "still generating" instead of letting a partial length look truncated.
  liveEl = h("span", { class: "ap-live", hidden: true, title: "still generating — the length grows until synthesis finishes" }, "⋯ live");
  playerRoot = h(
    "div",
    { class: "audio-player", hidden: true },
    toggleBtn,
    curTimeEl,
    trackEl,
    durTimeEl,
    liveEl,
    h("button", { type: "button", class: "ap-regen", title: "regenerate audio (re-synthesize, replaces the cached clip)", text: "⟳", onclick: regenerateAudio }),
    h("button", { type: "button", class: "ap-stop", title: "close player", text: "✕", onclick: stopReadAloud }),
  );
  attachTrackHandlers(trackEl);
  return playerRoot;
}

/** @param {HTMLElement} track */
function attachTrackHandlers(track) {
  /** @param {PointerEvent} ev @returns {number} */
  const fracAt = (ev) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) : 0;
  };
  track.addEventListener("pointerdown", (ev) => {
    if (!transport || transport.duration <= 0) return;
    ev.preventDefault();
    try {
      track.setPointerCapture(ev.pointerId);
    } catch {
      // Capture unsupported; drag still tracks via the element listeners.
    }
    dragging = true;
    dragWasPlaying = transport.playing;
    if (transport.playing) transport.pause();
    dragFrac = fracAt(ev);
    updatePlayerUi(dragFrac);
  });
  track.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    dragFrac = fracAt(ev);
    updatePlayerUi(dragFrac);
  });
  const end = (/** @type {PointerEvent} */ ev) => {
    if (!dragging) return;
    dragging = false;
    try {
      track.releasePointerCapture(ev.pointerId);
    } catch {
      // Already released.
    }
    if (!transport) return;
    transport.seek(dragFrac * transport.duration);
    if (dragWasPlaying) {
      transport.play();
      setPhase("playing");
      startTick();
    } else {
      setPhase("paused");
      updatePlayerUi();
    }
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
}

/** Play/pause/resume/replay from the player or the message button. */
function playerToggle() {
  if (!transport) return;
  if (transport.playing) {
    transport.pause();
    setPhase("paused");
    stopTick();
    updatePlayerUi();
    return;
  }
  // Resume, or replay from the top if we were sitting at the end.
  const atEnd = transport.done && transport.currentTime >= transport.duration - 0.05;
  transport.play(atEnd ? 0 : undefined);
  setPhase("playing");
  startTick();
}

/** Re-synthesize the active message from scratch, replacing a bad cached clip
 * (e.g. an old truncated stream). Busts the client PCM cache and tells the
 * server to skip its disk cache and overwrite the entry. */
function regenerateAudio() {
  const id = activeEventId;
  if (!id) return;
  pcmCache.delete(id);
  void startReadAloud(id, true);
}

function startTick() {
  cancelAnimationFrame(rafId);
  const step = () => {
    if (!transport) return;
    updatePlayerUi();
    if (transport.playing) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopTick() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Repaint the player nodes. `overrideFrac` (during a drag) shows the dragged
 * position without moving the transport.
 * @param {number} [overrideFrac] */
function updatePlayerUi(overrideFrac) {
  if (!playerRoot || !toggleBtn || !curTimeEl || !durTimeEl || !liveEl || !playedEl || !thumbEl) return;
  if (!transport) {
    playerRoot.hidden = true;
    return;
  }
  playerRoot.hidden = false;
  const dur = transport.duration;
  const cur = overrideFrac != null ? overrideFrac * dur : transport.currentTime;
  const frac = dur > 0 ? Math.min(1, cur / dur) : 0;
  const pct = `${(frac * 100).toFixed(2)}%`;
  playedEl.style.width = pct;
  thumbEl.style.left = pct;
  curTimeEl.textContent = fmtTime(cur);
  // Until synthesis finishes, the length is provisional and still growing — mark
  // it (~) and show the "⋯ live" badge so a partial total never reads as truncated.
  const generating = !transport.done;
  durTimeEl.textContent = `${generating ? "~" : ""}${fmtTime(dur)}`;
  liveEl.hidden = !generating;
  const playing = transport.playing;
  toggleBtn.textContent = playing ? "⏸" : "▶";
  toggleBtn.title = playing ? "pause" : "play";
  playerRoot.classList.toggle("loading", state.readAloud?.phase === "loading" && dur === 0);
  playerRoot.classList.toggle("generating", generating);
}

/** @param {number} seconds @returns {string} */
function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
