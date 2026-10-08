// TTS playback (rebuilt from scratch 2026-10-08): the per-message play button
// + the mini player above the composer.
// Server (POST .../tts) returns segment N of a message as a COMPLETE audio file;
// this plays them in order through ONE <audio> element. The browser owns
// output device, clock and decoding — no WebAudio, no PCM scheduling.
// Segments are fetched in order in the background while earlier ones play.
import { apiUrl } from "./api.js";
import { markDirty, setError } from "./render.js";
import { h } from "./dom.js";
import { state } from "./state.js";

/** @typedef {"loading"|"playing"|"paused"|"ended"} ReadAloudPhase */
/** @typedef {{workspaceId: string, roomId: string}} Origin */
/** @typedef {{url: string, duration: number}} Segment */
/**
 * @typedef {object} Session
 * @property {string} eventId
 * @property {Origin} origin
 * @property {{engine?: string}} options
 * @property {string} regenerate per-playback token; "" = use cache
 * @property {number} count total segments (0 until the first response)
 * @property {Segment[]} segments loaded so far, in order
 * @property {number} index segment in the <audio> element
 * @property {boolean} waiting playback reached a segment not loaded yet
 * @property {AbortController} controller
 */

// Tiny silent WAV: played once inside a user gesture so later programmatic
// play() (call replies, next segment) is allowed by autoplay policy.
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

const audio = new Audio();
audio.preload = "auto";
let unlocked = false;

/** @type {Session|null} */
let session = null;
let rafId = 0;

function unlockAudio() {
  if (unlocked || session) return;
  unlocked = true;
  audio.src = SILENCE;
  audio.play().then(() => { if (!session) audio.pause(); }).catch(() => { unlocked = false; });
}
for (const type of ["pointerdown", "keydown", "touchend"]) {
  window.addEventListener?.(type, unlockAudio, { capture: true, passive: true });
}

// ── element events ───────────────────────────────────────────────────────────────

audio.addEventListener("playing", () => { if (session) { setPhase("playing"); startTick(); } });
audio.addEventListener("pause", () => {
  if (!session || audio.ended || session.waiting) return;
  setPhase("paused");
  stopTick();
  updateUi();
});
audio.addEventListener("loadedmetadata", () => {
  const s = session;
  const seg = s?.segments[s.index];
  if (seg && Number.isFinite(audio.duration) && audio.duration > 0) seg.duration = audio.duration;
  updateUi();
});
audio.addEventListener("ended", () => {
  const s = session;
  if (!s) return;
  const next = s.index + 1;
  if (s.count && next >= s.count) {
    stopTick();
    setPhase("ended");
    updateUi();
    return;
  }
  if (s.segments[next]) void playSegment(s, next, 0);
  else {
    s.waiting = true;
    setPhase("loading");
    updateUi();
  }
});
audio.addEventListener("error", () => {
  if (!session || audio.src === SILENCE || !audio.error) return;
  const message = `Audio playback failed (${audio.error.message || `code ${audio.error.code}`})`;
  stopReadAloud();
  setError(new Error(message));
});

// ── session ──────────────────────────────────────────────────────────────────────

/** @param {ReadAloudPhase} phase */
function setPhase(phase) {
  const s = session;
  if (!s) return;
  if (state.readAloud?.eventId === s.eventId && state.readAloud.phase === phase) return;
  state.readAloud = { eventId: s.eventId, phase, ...s.origin };
  markDirty("transcript", "status");
}

/** @param {Session} s @param {number} index */
async function fetchSegment(s, index) {
  const base = `/api/workspaces/${encodeURIComponent(s.origin.workspaceId)}/rooms/${encodeURIComponent(s.origin.roomId)}/tts`;
  const body = JSON.stringify({ eventId: s.eventId, segment: index, ...s.options, ...(s.regenerate ? { regenerate: s.regenerate } : {}) });
  let lastError = /** @type {unknown} */ (null);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch(apiUrl(base), { method: "POST", headers: { "content-type": "application/json" }, body, signal: s.controller.signal });
      if (!response.ok) {
        const info = await response.json().catch(() => ({}));
        const error = new Error(info.error ?? `TTS failed: HTTP ${response.status}`);
        if (response.status < 500) throw Object.assign(error, { fatal: true });
        throw error;
      }
      const count = Number(response.headers.get("x-tts-segments"));
      if (Number.isInteger(count) && count > 0) s.count = count;
      const blob = await response.blob();
      if (!blob.size) throw new Error("TTS returned empty audio");
      return URL.createObjectURL(blob);
    } catch (error) {
      if (s.controller.signal.aborted || /** @type {{fatal?: boolean}} */ (error)?.fatal) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Probe a segment's duration without touching the playing element.
 * @param {string} url @returns {Promise<number>} */
function probeDuration(url) {
  return new Promise((resolve) => {
    const probe = new Audio();
    probe.preload = "metadata";
    const done = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
    probe.addEventListener("loadedmetadata", done, { once: true });
    probe.addEventListener("error", () => resolve(0), { once: true });
    probe.src = url;
  });
}

/** Fetch every segment in order; playback consumes them as they land.
 * @param {Session} s */
async function loadAll(s) {
  for (let index = 0; !s.count || index < s.count; index++) {
    const url = await fetchSegment(s, index);
    if (session !== s) { URL.revokeObjectURL(url); return; }
    const segment = { url, duration: 0 };
    s.segments[index] = segment;
    segment.duration = await probeDuration(url);
    if (session !== s) return;
    if (index === 0) await playSegment(s, 0, 0);
    else if (s.waiting && s.index === index - 1) await playSegment(s, index, 0);
    updateUi();
  }
}

/** @param {Session} s @param {number} index @param {number} offset @param {boolean} [play] */
async function playSegment(s, index, offset, play = true) {
  if (session !== s) return;
  s.waiting = false;
  if (s.index !== index || audio.src !== s.segments[index].url) {
    s.index = index;
    audio.src = s.segments[index].url;
  }
  if (offset > 0) {
    if (audio.readyState < 1) await new Promise((resolve) => audio.addEventListener("loadedmetadata", resolve, { once: true }));
    audio.currentTime = offset;
  }
  if (!play) { setPhase("paused"); updateUi(); return; }
  try {
    await audio.play();
  } catch (error) {
    if (session !== s) return;
    // Autoplay refused (no user gesture yet): sit paused; ▶ starts it.
    if (error instanceof DOMException && error.name === "NotAllowedError") { setPhase("paused"); updateUi(); return; }
    if (error instanceof DOMException && error.name === "AbortError") return;
    throw error;
  }
}

// ── public API ────────────────────────────────────────────────────────────────────

/** Message button: start, or toggle the message already loaded.
 * @param {string} eventId */
export function toggleReadAloud(eventId) {
  const s = session;
  const here = s && s.eventId === eventId && s.origin.workspaceId === state.snapshot?.workspace.id && s.origin.roomId === state.snapshot?.room.id;
  if (!here) { void startReadAloud(eventId); return; }
  if (state.readAloud?.phase === "loading" && !s.segments.length) { stopReadAloud(); return; }
  playerToggle();
}

/** Tear down playback and hide the player. */
export function stopReadAloud() {
  const s = session;
  session = null;
  stopTick();
  if (s) {
    s.controller.abort();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    for (const seg of s.segments) if (seg) URL.revokeObjectURL(seg.url);
  }
  if (state.readAloud) {
    state.readAloud = null;
    markDirty("transcript", "status");
  }
  updateUi();
}

/** @param {string} eventId
 * @param {boolean} [regenerate] bypass the server cache (⟳)
 * @param {Origin|null} [origin] room the message lives in (default: current)
 * @param {{engine?: string}} [options] engine override (chat calls) */
export async function startReadAloud(eventId, regenerate = false, origin = null, options = {}) {
  stopReadAloud();
  const snapshot = state.snapshot;
  const where = origin ?? (snapshot ? { workspaceId: snapshot.workspace.id, roomId: snapshot.room.id } : null);
  if (!where) return;
  /** @type {Session} */
  const s = {
    eventId,
    origin: where,
    options: options.engine ? { engine: options.engine } : {},
    regenerate: regenerate ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : "",
    count: 0,
    segments: [],
    index: 0,
    waiting: true,
    controller: new AbortController(),
  };
  session = s;
  setPhase("loading");
  updateUi();
  try {
    await loadAll(s);
  } catch (error) {
    if (session !== s || s.controller.signal.aborted) return;
    // Nothing played yet → close; mid-message → keep what loaded, end there.
    if (!s.segments.length) stopReadAloud();
    else { s.count = s.segments.length; if (s.waiting) { setPhase("ended"); updateUi(); } }
    setError(error instanceof Error ? error : new Error(String(error)));
  }
}

// ── player UI ────────────────────────────────────────────────────────────────────

/** @type {HTMLElement|null} */ let playerRoot = null;
/** @type {HTMLButtonElement|null} */ let toggleBtn = null;
/** @type {HTMLElement|null} */ let curEl = null;
/** @type {HTMLElement|null} */ let durEl = null;
/** @type {HTMLElement|null} */ let playedEl = null;
/** @type {HTMLElement|null} */ let thumbEl = null;
/** @type {HTMLElement|null} */ let liveEl = null;
let dragFrac = /** @type {number|null} */ (null);

/** Timeline over all segments: [elapsed, total, complete].
 * Unloaded segments are estimated from the mean of loaded ones. */
function timeline() {
  const s = session;
  if (!s) return { elapsed: 0, total: 0, complete: false };
  const known = s.segments.filter((seg) => seg && seg.duration > 0);
  const mean = known.length ? known.reduce((sum, seg) => sum + seg.duration, 0) / known.length : 0;
  const count = Math.max(s.count, s.segments.length);
  let total = 0;
  let before = 0;
  for (let i = 0; i < count; i++) {
    const d = s.segments[i]?.duration || mean;
    if (i < s.index) before += d;
    total += d;
  }
  const current = s.waiting ? (s.segments[s.index]?.duration ?? 0) : audio.currentTime || 0;
  const complete = s.count > 0 && s.segments.length >= s.count && known.length === s.count;
  return { elapsed: Math.min(total, before + current), total, complete };
}

/** Seek to a fraction of the whole message (loaded part only).
 * @param {number} frac */
function seekTo(frac) {
  const s = session;
  if (!s) return;
  const { total } = timeline();
  let target = frac * total;
  for (let i = 0; i < s.segments.length; i++) {
    const seg = s.segments[i];
    if (!seg) break;
    if (target <= seg.duration || i === s.segments.length - 1) {
      const resume = state.readAloud?.phase === "playing" || state.readAloud?.phase === "ended";
      void playSegment(s, i, Math.max(0, Math.min(target, seg.duration - 0.05)), resume);
      return;
    }
    target -= seg.duration;
  }
}

function playerToggle() {
  const s = session;
  if (!s || !s.segments.length) return;
  if (state.readAloud?.phase === "ended") { void playSegment(s, 0, 0); return; }
  if (s.waiting) return;
  if (audio.paused) void audio.play().catch((error) => setError(error));
  else audio.pause();
}

function regenerate() {
  const s = session;
  if (s) void startReadAloud(s.eventId, true, s.origin, s.options);
}

function startTick() {
  cancelAnimationFrame(rafId);
  const step = () => {
    updateUi();
    if (session && !audio.paused) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}
function stopTick() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/** @param {number} seconds */
function fmt(seconds) {
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function updateUi() {
  if (!playerRoot || !toggleBtn || !curEl || !durEl || !playedEl || !thumbEl || !liveEl) return;
  const s = session;
  playerRoot.hidden = !s;
  if (!s) return;
  const { elapsed, total, complete } = timeline();
  const shown = dragFrac != null ? dragFrac * total : elapsed;
  const pct = `${(total > 0 ? Math.min(1, shown / total) * 100 : 0).toFixed(2)}%`;
  playedEl.style.width = pct;
  thumbEl.style.left = pct;
  curEl.textContent = fmt(shown);
  durEl.textContent = `${complete ? "" : "~"}${fmt(total)}`;
  liveEl.hidden = complete;
  const phase = state.readAloud?.phase;
  toggleBtn.textContent = phase === "loading" ? "◌" : phase === "playing" ? "⏸" : "▶";
  toggleBtn.title = phase === "loading" ? "generating audio…" : phase === "playing" ? "pause" : phase === "ended" ? "replay" : "play";
  playerRoot.classList.toggle("loading", phase === "loading");
  playerRoot.classList.toggle("generating", !complete);
}

/** The mini player (built once; composer mounts it). */
export function buildAudioPlayer() {
  toggleBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "ap-toggle", title: "play", text: "▶", onclick: playerToggle }));
  curEl = h("span", { class: "ap-time" }, "0:00");
  durEl = h("span", { class: "ap-time ap-dur" }, "0:00");
  playedEl = h("div", { class: "ap-played" });
  thumbEl = h("div", { class: "ap-thumb" });
  const track = h("div", { class: "ap-track", title: "click or drag to seek" }, playedEl, thumbEl);
  liveEl = h("span", { class: "ap-live", hidden: true, title: "still generating — total is an estimate" }, "⋯ live");
  playerRoot = h(
    "div",
    { class: "audio-player", hidden: true },
    toggleBtn,
    curEl,
    track,
    durEl,
    liveEl,
    h("button", { type: "button", class: "ap-regen", title: "regenerate audio (bypass cache)", text: "⟳", onclick: regenerate }),
    h("button", { type: "button", class: "ap-stop", title: "close player", text: "✕", onclick: stopReadAloud }),
  );
  /** @param {PointerEvent} ev */
  const fracAt = (ev) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) : 0;
  };
  track.addEventListener("pointerdown", (ev) => {
    if (!session?.segments.length) return;
    ev.preventDefault();
    try { track.setPointerCapture(ev.pointerId); } catch { /* unsupported */ }
    dragFrac = fracAt(ev);
    updateUi();
  });
  track.addEventListener("pointermove", (ev) => {
    if (dragFrac == null) return;
    dragFrac = fracAt(ev);
    updateUi();
  });
  /** @param {PointerEvent} ev */
  const end = (ev) => {
    if (dragFrac == null) return;
    const frac = dragFrac;
    dragFrac = null;
    try { track.releasePointerCapture(ev.pointerId); } catch { /* released */ }
    seekTo(frac);
    updateUi();
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  return playerRoot;
}
