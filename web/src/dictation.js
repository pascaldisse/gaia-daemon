// Composer dictation (voice INPUT): the mic button records a short clip, the
// daemon transcribes it (ElevenLabs Scribe by default; the STT engine is
// swappable in voice.json), and the text lands in the composer. This is the
// one-shot mirror of read-aloud; live-CALL STT is the separate streaming path
// in voice.js (which writes the composer as the agent hears you).
//
// IN-MEMORY ONLY: recorded chunks live in a plain array on the session
// object, nothing is persisted to disk. Browser disk-database transactions
// hang in WKWebView, and the stop→transcribe→send path must never await
// anything except the recorder stop (watchdogged) and the transcription
// fetch itself.
// A failed clip is kept in a module variable so the user can retry or
// discard it, but nothing survives a reload/crash — there are no recovered
// drafts anymore.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

const WAVE_BARS = 28;
const METER_THROTTLE_MS = 100;
const MAX_RECORD_MS = 5 * 60 * 1000;
const FINISH_WATCHDOG_MS = 1500;

/**
 * @typedef {Object} DictationSession
 * @property {MediaStream} stream
 * @property {MediaRecorder} recorder
 * @property {AudioContext|null} audioCtx
 * @property {AnalyserNode|null} analyser
 * @property {Uint8Array|null} analyserData
 * @property {number} rafId
 * @property {number} startedAtMs
 * @property {number} timerId
 * @property {number} lastMeterMs
 * @property {Blob[]} chunks
 * @property {string} clipId
 */

/** @type {DictationSession|null} */
let session = null;
/** @type {Blob|null} */
let lastFailedClip = null;
/** @type {Promise<boolean>|null} */
let activeTranscriptionPromise = null;

/** Toggle recording: start if idle, else stop-and-transcribe. */
export async function toggleDictation() {
  if (session) {
    await stopAndTranscribe();
    return;
  }
  await startDictation();
}

async function startDictation() {
  // A live call already transcribes speech into the composer; a second mic
  // stream would just fight it.
  if (state.voice) {
    setError(new Error(`You're on a call with @${state.voice.agentId} — just speak, it transcribes live.`));
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    state.dictationError = "microphone needs HTTPS or localhost";
    markDirty("composer");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    state.dictationError = "this browser can't record audio";
    markDirty("composer");
    return;
  }

  lastFailedClip = null;
  state.dictationError = "";

  /** @type {MediaStream} */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    state.dictationError = "microphone permission denied or unavailable";
    markDirty("composer");
    return;
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  /** @type {DictationSession} */
  const current = {
    stream,
    recorder,
    audioCtx: null,
    analyser: null,
    analyserData: null,
    rafId: 0,
    startedAtMs: Date.now(),
    timerId: 0,
    lastMeterMs: 0,
    chunks: [],
    clipId: newClipId(),
  };
  session = current;
  state.dictating = true;
  state.dictationBusy = false;
  state.dictationBars = flatBars();
  state.dictationLevel = 0;

  startMeter(current);
  // 1s timeslice: each dataavailable chunk lands in the in-memory array —
  // that's the only place recorded audio ever lives.
  recorder.ondataavailable = (event) => {
    if (!event.data || !event.data.size) return;
    current.chunks.push(event.data);
    // Durability: stream the chunk to disk server-side, fire-and-forget. This
    // must never gate or delay recording/stop/transcribe — no await, and any
    // failure (offline, reload mid-flight) is silently swallowed since the
    // in-memory chunks array remains the source of truth for the send path.
    void fetch(`/api/voice/clip/${current.clipId}/chunk`, { method: "POST", body: event.data }).catch(() => {});
  };
  recorder.start(1000);
  current.timerId = window.setTimeout(() => void stopAndTranscribe(), MAX_RECORD_MS);
  markDirty("composer");
}

/** Stop recording and transcribe what was captured. @returns {Promise<boolean>} */
async function stopAndTranscribe() {
  const current = session;
  if (!current) return false;
  session = null;
  state.dictating = false;
  markDirty("composer");

  stopMeter(current);
  if (current.timerId) clearTimeout(current.timerId);

  try {
    await new Promise((resolve, reject) => {
      const watchdog = window.setTimeout(() => reject(new Error("watchdog")), FINISH_WATCHDOG_MS);
      current.recorder.onstop = () => {
        clearTimeout(watchdog);
        resolve(undefined);
      };
      current.recorder.onerror = () => {
        clearTimeout(watchdog);
        reject(new Error("recording failed"));
      };
      try {
        if (current.recorder.state !== "inactive") current.recorder.stop();
        else resolve(undefined);
      } catch {
        reject(new Error("recording failed"));
      }
    });
  } catch {
    // Watchdog fired (or stop() threw): fall back to whatever chunks are
    // already cached in memory instead of failing the recording outright.
  }

  stopStreamTracks(current.stream);
  void current.audioCtx?.close().catch(() => {});

  const mimeType = current.recorder.mimeType || current.chunks[0]?.type || "audio/webm";
  const clip = current.chunks.length ? new Blob(current.chunks, { type: mimeType }) : null;

  if (!clip || !clip.size) {
    state.dictationError = "no audio captured";
    state.dictationBusy = false;
    markDirty("composer");
    return false;
  }

  return await transcribe(clip);
}

/**
 * POST the clip to the daemon and insert the transcript.
 * @param {Blob} blob
 * @param {string} [draftId] unused — kept for call-site compatibility.
 * @returns {Promise<boolean>}
 */
export async function transcribe(blob, draftId) {
  if (activeTranscriptionPromise) return await activeTranscriptionPromise;
  activeTranscriptionPromise = runTranscribe(blob);
  try {
    return await activeTranscriptionPromise;
  } finally {
    activeTranscriptionPromise = null;
  }
}

/** @param {Blob} blob @returns {Promise<boolean>} */
async function runTranscribe(blob) {
  state.dictationBusy = true;
  state.dictating = false;
  state.dictationError = "";
  markDirty("composer");
  const result = await postClip(blob);
  if (result.ok) {
    insertTranscript(result.text);
    lastFailedClip = null;
    state.dictationError = "";
    state.dictationBars = flatBars();
    state.dictationLevel = 0;
    state.dictationBusy = false;
    markDirty("composer");
    return true;
  }
  lastFailedClip = blob;
  state.dictationError = result.error;
  state.dictationBusy = false;
  markDirty("composer");
  return false;
}

/**
 * Raw network call — no state mutation.
 * @param {Blob} blob
 * @returns {Promise<{ok: boolean, text: string, error: string}>}
 */
async function postClip(blob) {
  try {
    // Not via api.js: the body is raw audio, not JSON, so the content-type
    // must be the clip's MIME.
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": blob.type || "application/octet-stream" },
      body: blob,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, text: "", error: String(data.error ?? `transcription failed: ${response.status}`) };
    const text = String(data.text ?? "").trim();
    if (!text) return { ok: false, text: "", error: "no speech detected" };
    return { ok: true, text, error: "" };
  } catch (error) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Retry transcribing the clip that previously failed. @returns {Promise<boolean>} */
export async function retryDictation() {
  if (!lastFailedClip) return true;
  return await transcribe(lastFailedClip);
}

/** Drop the failed clip and clear the error. */
export function discardFailedDictation() {
  lastFailedClip = null;
  state.dictationError = "";
  markDirty("composer");
}

/** @returns {boolean} */
export function hasFailedDictation() {
  return Boolean(lastFailedClip);
}

/** Abort the active recording WITHOUT transcribing. */
export function cancelDictation() {
  const current = session;
  if (!current) return;
  session = null;
  stopMeter(current);
  if (current.timerId) clearTimeout(current.timerId);
  current.recorder.ondataavailable = null;
  current.recorder.onstop = null;
  current.recorder.onerror = null;
  try {
    if (current.recorder.state !== "inactive") current.recorder.stop();
  } catch {
    // Already stopped.
  }
  stopStreamTracks(current.stream);
  void current.audioCtx?.close().catch(() => {});
  state.dictating = false;
  state.dictationBusy = false;
  state.dictationBars = flatBars();
  state.dictationLevel = 0;
  markDirty("composer");
}

/**
 * Used by the main send action. Ensures dictation resolves before send.
 * Always resolves true — even when transcription failed, since the failed
 * clip stays as a retry/discard chip and any typed text must still send
 * (empty sends are already guarded in actions.js).
 * @returns {Promise<boolean>}
 */
export async function finalizeDictationForSend() {
  if (state.dictating) {
    await stopAndTranscribe();
    return true;
  }
  if (state.dictationBusy) {
    if (activeTranscriptionPromise) await activeTranscriptionPromise;
    return true;
  }
  return true;
}

export function installDictationLifecycle() {
  void refreshDictationDrafts();
  window.addEventListener("pagehide", () => {
    if (!session) return;
    const current = session;
    session = null;
    stopMeter(current);
    if (current.timerId) clearTimeout(current.timerId);
    current.recorder.ondataavailable = null;
    current.recorder.onstop = null;
    current.recorder.onerror = null;
    try {
      if (current.recorder.state !== "inactive") current.recorder.stop();
    } catch {
      // Already stopped.
    }
    stopStreamTracks(current.stream);
    void current.audioCtx?.close().catch(() => {});
    state.dictating = false;
    state.dictationBusy = false;
  });
}

/** No persistence layer anymore: always clears the (now-vestigial) drafts list. */
export async function refreshDictationDrafts() {
  if (state.dictationDrafts.length) {
    state.dictationDrafts = [];
    markDirty("composer");
  }
}

/** @returns {Promise<never[]>} */
export async function listRecoveredDrafts() {
  return [];
}

/** @param {string} id @returns {Promise<boolean>} */
export async function transcribeRecoveredDraft(id) {
  return false;
}

/** @param {string} id @returns {Promise<void>} */
export async function discardRecoveredDraft(id) {}

/**
 * Append the transcript to whatever is already in the composer (so dictation
 * augments a partially-typed message instead of clobbering it).
 * @param {string} text
 */
function insertTranscript(text) {
  const existing = state.composerText.replace(/\s+$/, "");
  state.composerText = existing ? `${existing} ${text}` : text;
  state.completionHidden = true;
  markDirty("composer");
  // Put the caret at the end so the user can keep typing / hit Enter.
  const textarea = document.querySelector(".command-input");
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.value = state.composerText;
    textarea.focus();
    textarea.setSelectionRange(state.composerText.length, state.composerText.length);
  }
}

/** An opaque id for this recording session's server-side clip file. Must match
 * the server's /^[a-z0-9-]{1,64}$/ — base36 is already lowercase, but force it
 * in case a future Math.random() implementation ever isn't.
 * @returns {string} */
function newClipId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

/** Prefer opus in webm/ogg (small, widely accepted), fall back to mp4/mpeg. */
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg"];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return "";
}

/** @param {DictationSession} current */
function startMeter(current) {
  try {
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(current.stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    current.audioCtx = audioCtx;
    current.analyser = analyser;
    current.analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    pumpMeter(current);
  } catch {
    // Meter is visual only; recording still works.
  }
}

/** @param {DictationSession} current */
function pumpMeter(current) {
  if (!current.analyser || !current.analyserData || session !== current) return;
  current.analyser.getByteTimeDomainData(/** @type {Uint8Array<ArrayBuffer>} */ (current.analyserData));
  let sum = 0;
  for (const value of current.analyserData) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.min(1, Math.sqrt(sum / current.analyserData.length) * 4.5);
  // Throttle state writes: the meter runs at rAF but the UI only needs ~10fps.
  const now = Date.now();
  if (now - current.lastMeterMs >= METER_THROTTLE_MS) {
    current.lastMeterMs = now;
    state.dictationBars = [...state.dictationBars.slice(-WAVE_BARS + 1), Math.max(0.04, rms)];
    state.dictationLevel = rms;
    markDirty("composer");
  }
  current.rafId = requestAnimationFrame(() => pumpMeter(current));
}

/** @param {DictationSession} current */
function stopMeter(current) {
  if (current.rafId) cancelAnimationFrame(current.rafId);
  current.rafId = 0;
  current.analyser = null;
  current.analyserData = null;
}

/** @returns {number[]} */
function flatBars() {
  return Array.from({ length: WAVE_BARS }, () => 0.04);
}

/** @param {MediaStream} stream */
function stopStreamTracks(stream) {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Track already ended.
    }
  }
}
