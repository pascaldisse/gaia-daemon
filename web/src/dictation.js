// Composer dictation (voice INPUT): the mic button records a short clip, the
// daemon transcribes it (ElevenLabs Scribe by default; the STT engine is
// swappable in voice.json), and the text lands in the composer. This is the
// one-shot mirror of read-aloud; live-CALL STT is the separate streaming path
// in voice.js (which writes the composer as the agent hears you).
//
// IN-MEMORY ONLY on the client: recorded chunks live in a plain array on the
// session object, nothing is persisted to browser disk (no IndexedDB — those
// transactions hang in WKWebView, and the stop→transcribe→send path must
// never await anything except the recorder stop (watchdogged) and the
// transcription fetch itself). Durability instead comes from the SERVER: each
// recorded chunk is also streamed, fire-and-forget, to a clip file the daemon
// keeps on disk (see ondataavailable below); refreshRecoveredClips/
// transcribeRecoveredClip/discardRecoveredClip below recover from that
// server-side file after a crash/reload, with zero client-side storage.
// A failed clip also stays in a module variable so the user can retry or
// discard it without a round trip to the server.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

const WAVE_BARS = 28;
const METER_THROTTLE_MS = 100;
const MAX_RECORD_MS = 5 * 60 * 1000;
const FINISH_WATCHDOG_MS = 1500;
// After stopping, how long to wait for the chunk-upload chain to flush before
// giving up on the server-side clip file and uploading the full in-memory
// blob instead. Transcribing the on-disk clip is only safe once every chunk
// has landed — otherwise the daemon reads a truncated file and the tail of
// the recording is cut off.
const UPLOAD_FLUSH_WATCHDOG_MS = 2000;
// One transcription attempt (which may cover two sequential fetches — the
// clip-transcribe try, then the upload fallback) gets this long before it's
// treated as failed. Recording itself is never subject to this timeout.
const TRANSCRIBE_TIMEOUT_MS = 45000;

/** @param {number} ms @returns {AbortSignal|undefined} */
function fetchTimeout(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

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
 * @property {Promise<void>} uploadChain
 */

/** @type {DictationSession|null} */
let session = null;
/** @type {Blob|null} */
let lastFailedClip = null;
/** @type {Promise<boolean>|null} */
let activeTranscriptionPromise = null;
/** Tail of the transcription queue — chains each transcribe() call behind the
 * previous one so a hung/failed earlier attempt can never swallow a later
 * clip; each call still resolves to its OWN result. @type {Promise<boolean>} */
let queueTail = Promise.resolve(false);
/** The AbortController backing whichever transcription fetch is currently in
 * flight, so the composer's "cancel" chip (abortActiveTranscription) can
 * reach in and abort it. @type {AbortController|null} */
let activeAbortController = null;

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
    uploadChain: Promise.resolve(),
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
    // Durability: stream the chunk to disk server-side. Chained behind the
    // previous chunk's upload (not fired in parallel) so the server's appends
    // land in recording order AND so stopAndTranscribe can tell when the
    // on-disk file is complete — parallel fire-and-forget uploads let the
    // final chunk race the clip-transcribe call and cut off the recording's
    // tail. Still never awaited here (recording/stop are never gated), and
    // failures are swallowed: the in-memory chunks array remains the source
    // of truth for the send path.
    current.uploadChain = current.uploadChain
      .then(() => fetch(`/api/voice/clip/${current.clipId}/chunk`, { method: "POST", body: event.data }))
      .then(() => undefined, () => undefined);
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

  // Only let the daemon transcribe its on-disk clip file if every chunk
  // upload has actually landed — otherwise it reads a truncated file and the
  // tail of the recording (everything said after the last flushed chunk) is
  // silently cut off. Watchdogged: if the chain hasn't flushed in time, the
  // full in-memory blob is uploaded instead, which always has the tail.
  const clipFileComplete = await Promise.race([
    current.uploadChain.then(() => true),
    /** @type {Promise<boolean>} */ (new Promise((resolve) => window.setTimeout(() => resolve(false), UPLOAD_FLUSH_WATCHDOG_MS))),
  ]);
  return await transcribe(clip, current.clipId, clipFileComplete);
}

/**
 * Transcribe a recorded clip and insert the result into the composer. Calls
 * queue behind one another (queueTail) instead of the old singleton
 * early-return, so a hung or failed earlier transcription can never swallow a
 * later clip — every call still resolves to its OWN result once its turn
 * comes up.
 * @param {Blob} blob
 * @param {string} [clipId] the recording session's server-side clip id (see
 *   newClipId) — lets runTranscribe try the cheaper already-uploaded-clip
 *   path before falling back to a full upload. Omitted when retrying a
 *   previously-failed clip, which has no clip id.
 * @param {boolean} [clipFileComplete] whether every chunk upload for clipId
 *   has landed on disk — the cheaper clip-transcribe path is only safe (and
 *   only tried) when true; otherwise the full blob is uploaded.
 * @returns {Promise<boolean>}
 */
export async function transcribe(blob, clipId, clipFileComplete) {
  const next = queueTail.catch(() => false).then(() => runTranscribe(blob, clipId, clipFileComplete));
  queueTail = next;
  activeTranscriptionPromise = next;
  try {
    return await next;
  } finally {
    if (activeTranscriptionPromise === next) activeTranscriptionPromise = null;
  }
}

/**
 * @param {Blob} blob
 * @param {string} [clipId]
 * @param {boolean} [clipFileComplete]
 * @returns {Promise<boolean>}
 */
async function runTranscribe(blob, clipId, clipFileComplete) {
  state.dictationBusy = true;
  state.dictating = false;
  state.dictationError = "";
  markDirty("composer");

  const { signal, settle } = requestSignal(TRANSCRIBE_TIMEOUT_MS);
  try {
    // Prefer the clip already streamed to the daemon during recording (no
    // second upload of the audio) — but ONLY when the upload chain confirmed
    // the on-disk file is complete; fall back to a full upload on ANY failure
    // of that call (non-ok response or thrown, including our own abort/timeout).
    if (clipId && clipFileComplete) {
      const viaClip = await postClipTranscribe(clipId, blob?.type, signal);
      if (viaClip.ok) {
        insertTranscript(viaClip.text);
        lastFailedClip = null;
        state.dictationError = "";
        state.dictationBars = flatBars();
        state.dictationLevel = 0;
        state.dictationBusy = false;
        markDirty("composer");
        return true;
      }
    }
    const result = await postClip(blob, signal);
    if (result.ok) {
      // The upload route archived the complete audio server-side (final-*),
      // so the partially-streamed .bin is now redundant — discard it (the
      // server renames it to discarded-*, never deletes) so it can't
      // resurface as a ghost recovered-recording chip.
      if (clipId) void fetch(`/api/voice/clip/${clipId}`, { method: "DELETE" }).catch(() => {});
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
  } finally {
    settle();
  }
}

/**
 * Ask the daemon to transcribe a clip it already has on disk (streamed there
 * during recording, or recovered after a crash/reload) — no blob upload.
 * @param {string} clipId
 * @param {string} [mimeType] only sent for the just-recorded clip, whose MIME
 *   the daemon otherwise can't know; recovered clips are transcribed without it.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, text: string, engine: string, error: string}>}
 */
async function postClipTranscribe(clipId, mimeType, signal) {
  const query = mimeType ? `?mime=${encodeURIComponent(mimeType)}` : "";
  try {
    const response = await fetch(`/api/voice/clip/${clipId}/transcribe${query}`, { method: "POST", signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, text: "", engine: "", error: String(data.error ?? `transcription failed: ${response.status}`) };
    return { ok: true, text: String(data.text ?? ""), engine: String(data.engine ?? ""), error: "" };
  } catch (error) {
    return { ok: false, text: "", engine: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Raw network call — no state mutation.
 * @param {Blob} blob
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, text: string, error: string}>}
 */
async function postClip(blob, signal) {
  try {
    // Not via api.js: the body is raw audio, not JSON, so the content-type
    // must be the clip's MIME.
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": blob.type || "application/octet-stream" },
      body: blob,
      signal,
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

/**
 * A timeout for one transcription attempt, backed by a real AbortController
 * when available so abortActiveTranscription() (the composer's "cancel" chip)
 * can reach in and abort whichever fetch is currently in flight — the busy
 * state can span two sequential fetches (clip-transcribe try, then upload
 * fallback), and both share this one controller/timer. Falls back to a
 * plain timeout-only signal when AbortController isn't available.
 * @param {number} ms
 * @returns {{signal: AbortSignal|undefined, settle: () => void}}
 */
function requestSignal(ms) {
  if (typeof AbortController === "undefined") return { signal: fetchTimeout(ms), settle: () => {} };
  const controller = new AbortController();
  activeAbortController = controller;
  const timer = window.setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    settle: () => {
      clearTimeout(timer);
      if (activeAbortController === controller) activeAbortController = null;
    },
  };
}

/** Cancel whatever transcription attempt is currently in flight (the
 * composer's "cancel" chip, shown while state.dictationBusy). The abort
 * rejects the in-flight fetch, which flows into runTranscribe's existing
 * failure/fallback handling exactly like a timeout or network error would —
 * clearing busy and leaving a retry/discard chip behind. */
export function abortActiveTranscription() {
  activeAbortController?.abort();
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
  void refreshRecoveredClips();
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

/**
 * Pull the list of clips the daemon still has on disk — streamed there by the
 * fire-and-forget chunk uploads in ondataavailable, so this recovers clips
 * left behind by a crash/reload with zero client-side storage. Surfaced as
 * recovered-recording chips in the composer (see composer.js's
 * DictationDraftChips). Silently no-ops on any fetch failure (offline, daemon
 * restarting) — whatever drafts are already shown just stay as they are.
 * @returns {Promise<void>}
 */
export async function refreshRecoveredClips() {
  try {
    const response = await fetch("/api/voice/clips");
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    /** @type {{id?: unknown, bytes?: unknown, mtimeMs?: unknown}[]} */
    const clips = Array.isArray(data.clips) ? data.clips : [];
    const activeClipId = session?.clipId;
    state.dictationDrafts = clips
      .filter((clip) => typeof clip.id === "string" && clip.id !== activeClipId)
      .map((clip) => ({ id: /** @type {string} */ (clip.id), bytes: Number(clip.bytes) || 0, mtimeMs: Number(clip.mtimeMs) || 0 }));
    markDirty("composer");
  } catch {
    // Offline / daemon restarting — keep whatever drafts were already shown.
  }
}

/**
 * Transcribe a clip the daemon recovered from a previous crash/reload — it
 * already lives server-side, so this is a bare POST with no blob to upload.
 * On success, inserts the transcript the same way a live recording does and
 * drops the recovered entry; on failure the entry is NOT removed (it stays as
 * a still-clickable chip — the failure just surfaces via state.dictationError).
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function transcribeRecoveredClip(id) {
  const { signal, settle } = requestSignal(TRANSCRIBE_TIMEOUT_MS);
  try {
    const result = await postClipTranscribe(id, undefined, signal);
    if (result.ok) {
      insertTranscript(result.text);
      state.dictationDrafts = state.dictationDrafts.filter((draft) => draft.id !== id);
      markDirty("composer");
      return true;
    }
    state.dictationError = result.error;
    markDirty("composer");
    return false;
  } finally {
    settle();
  }
}

/**
 * Drop a recovered clip. The daemon archives the file rather than deleting it
 * outright, so this is safe even if the DELETE call itself fails offline —
 * the chip is removed from the composer either way.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function discardRecoveredClip(id) {
  try {
    await fetch(`/api/voice/clip/${id}`, { method: "DELETE" });
  } catch {
    // Offline — the server-side file just outlives this client's view of it.
  }
  state.dictationDrafts = state.dictationDrafts.filter((draft) => draft.id !== id);
  markDirty("composer");
}

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
