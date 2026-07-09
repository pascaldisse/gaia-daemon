// Composer dictation (voice INPUT): the mic button records a short clip, the
// daemon transcribes it (ElevenLabs Scribe by default; the STT engine is
// swappable in voice.json), and the text lands in the composer. This is the
// one-shot mirror of read-aloud; live-CALL STT is the separate streaming path
// in voice.js (which writes the composer as the agent hears you).
//
// Durability lives UNDER the in-memory recorder, never in front of it: the
// in-memory chunk array is the primary path for the live transcribe (send
// NEVER waits on a disk read), and IndexedDB is a best-effort mirror so a
// crash/reload doesn't lose the audio. A failed clip is also kept in a module
// variable so the user can retry or discard, mirroring the pre-durability
// behavior. Recovered drafts (from a crash/reload) surface as chips the user
// can transcribe or discard — they never gate or hijack live recording/send.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

const WAVE_BARS = 28;
const METER_THROTTLE_MS = 100;
const MAX_RECORD_MS = 5 * 60 * 1000;
const FINISH_WATCHDOG_MS = 5000;

const DB_NAME = "gaia-dictation-drafts";
const DB_VERSION = 1;
const DRAFTS_STORE = "drafts";
const CHUNKS_STORE = "chunks";

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
 * @property {string} draftId
 * @property {number} seq
 * @property {Blob[]} chunks
 */

/**
 * @typedef {Object} DraftRecord
 * @property {string} id
 * @property {string} roomId
 * @property {string} workspaceId
 * @property {number} startedAt
 * @property {string} mimeType
 * @property {"recording"|"saved"|"failed"} status
 * @property {number} durationMs
 * @property {string} error
 */

/**
 * @typedef {Object} ChunkRecord
 * @property {string} draftId
 * @property {number} seq
 * @property {Blob} blob
 */

/**
 * @typedef {Object} RecoveredDraft
 * @property {string} id
 * @property {number} startedAt
 * @property {number} durationMs
 * @property {Blob} blob
 * @property {"recording"|"saved"|"failed"} status
 * @property {string} error
 */

/** @type {DictationSession|null} */
let session = null;
/** @type {Blob|null} */
let lastFailedClip = null;
/** @type {string|null} */
let lastFailedDraftId = null;
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
  lastFailedDraftId = null;
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

  // Audio hits disk from the moment recording starts: the draft row is
  // created (best-effort) BEFORE recorder.start. If IndexedDB is unavailable
  // or the write fails, recording proceeds anyway — never refuse to record —
  // and a note (not a block) says so.
  const draftId = randomId();
  const snapshot = state.snapshot;
  /** @type {DraftRecord} */
  const draft = {
    id: draftId,
    roomId: snapshot?.room.id ?? "",
    workspaceId: snapshot?.workspace.id ?? "",
    startedAt: Date.now(),
    mimeType: mimeType || recorder.mimeType || "audio/webm",
    status: "recording",
    durationMs: 0,
    error: "",
  };
  const persisted = await putDraft(draft);
  if (!persisted) state.dictationError = "recording is not crash-safe here";

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
    draftId,
    seq: 0,
    chunks: [],
  };
  session = current;
  state.dictating = true;
  state.dictationBusy = false;
  state.dictationBars = flatBars();
  state.dictationLevel = 0;

  startMeter(current);
  // 1s timeslice: each dataavailable chunk lands in the in-memory array
  // (primary — the live stop/transcribe path never reads back from
  // IndexedDB) AND is fire-and-forget mirrored to the `chunks` store with an
  // incrementing seq, so a crash mid-recording still leaves recoverable audio
  // on disk instead of only the last chunk.
  recorder.ondataavailable = (event) => {
    if (!event.data || !event.data.size) return;
    current.chunks.push(event.data);
    const seq = current.seq++;
    void putChunk({ draftId, seq, blob: event.data });
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
      const watchdog = window.setTimeout(() => reject(new Error("recording did not finish")), FINISH_WATCHDOG_MS);
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
  } catch (error) {
    stopStreamTracks(current.stream);
    void current.audioCtx?.close().catch(() => {});
    state.dictationError = error instanceof Error ? error.message : "recording did not finish";
    state.dictationBusy = false;
    void updateDraft(current.draftId, { status: "failed", error: state.dictationError });
    markDirty("composer");
    return false;
  }

  stopStreamTracks(current.stream);
  void current.audioCtx?.close().catch(() => {});

  // Assembled from the IN-MEMORY chunks only — the live path never reads
  // back from IndexedDB.
  const mimeType = current.recorder.mimeType || current.chunks[0]?.type || "audio/webm";
  const clip = current.chunks.length ? new Blob(current.chunks, { type: mimeType }) : null;

  if (!clip || !clip.size) {
    state.dictationError = "no audio captured";
    state.dictationBusy = false;
    void updateDraft(current.draftId, { status: "failed", error: state.dictationError });
    markDirty("composer");
    return false;
  }

  await updateDraft(current.draftId, { status: "saved", durationMs: Date.now() - current.startedAtMs });
  return await transcribe(clip, current.draftId);
}

/**
 * POST the clip to the daemon and insert the transcript.
 * @param {Blob} blob
 * @param {string} [draftId] the persisted draft this clip came from, if any —
 *   deleted on success, marked "failed" on failure.
 * @returns {Promise<boolean>}
 */
export async function transcribe(blob, draftId) {
  if (activeTranscriptionPromise) return await activeTranscriptionPromise;
  activeTranscriptionPromise = runTranscribe(blob, draftId);
  try {
    return await activeTranscriptionPromise;
  } finally {
    activeTranscriptionPromise = null;
  }
}

/** @param {Blob} blob @param {string} [draftId] @returns {Promise<boolean>} */
async function runTranscribe(blob, draftId) {
  state.dictationBusy = true;
  state.dictating = false;
  state.dictationError = "";
  markDirty("composer");
  const result = await postClip(blob);
  if (result.ok) {
    insertTranscript(result.text);
    lastFailedClip = null;
    lastFailedDraftId = null;
    state.dictationError = "";
    state.dictationBars = flatBars();
    state.dictationLevel = 0;
    if (draftId) await deleteDraftAndChunks(draftId);
    state.dictationBusy = false;
    markDirty("composer");
    return true;
  }
  lastFailedClip = blob;
  lastFailedDraftId = draftId ?? null;
  state.dictationError = result.error;
  if (draftId) await updateDraft(draftId, { status: "failed", error: result.error });
  state.dictationBusy = false;
  markDirty("composer");
  return false;
}

/**
 * Raw network call — no state mutation — shared by the live path and the
 * recovered-draft path.
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
  return await transcribe(lastFailedClip, lastFailedDraftId ?? undefined);
}

/** Drop the failed clip and clear the error. Explicit user discard: the
 * persisted draft (if any) is deleted too. */
export function discardFailedDictation() {
  const draftId = lastFailedDraftId;
  lastFailedClip = null;
  lastFailedDraftId = null;
  state.dictationError = "";
  if (draftId) void deleteDraftAndChunks(draftId);
  markDirty("composer");
}

/** @returns {boolean} */
export function hasFailedDictation() {
  return Boolean(lastFailedClip);
}

/** Abort the active recording WITHOUT transcribing. Explicit user discard —
 * the persisted draft and its chunks are dropped too. */
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
  void deleteDraftAndChunks(current.draftId);
  state.dictating = false;
  state.dictationBusy = false;
  state.dictationBars = flatBars();
  state.dictationLevel = 0;
  markDirty("composer");
}

/**
 * Used by the main send action. Ensures dictation resolves before send, but a
 * failed clip must NEVER block sending. Never gates on any stored/recovered
 * draft — only on the live session's own state.
 * @returns {Promise<boolean>}
 */
export async function finalizeDictationForSend() {
  if (state.dictating) return await stopAndTranscribe();
  if (state.dictationBusy) return activeTranscriptionPromise ? await activeTranscriptionPromise : true;
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
    stopStreamTracks(current.stream);
    void current.audioCtx?.close().catch(() => {});
    // Chunks are already on disk; best-effort mark the draft "saved" so a
    // reload can offer it as a recovered chip instead of a stuck "recording".
    void updateDraft(current.draftId, { status: "saved", durationMs: Date.now() - current.startedAtMs });
    state.dictating = false;
    state.dictationBusy = false;
  });
}

/**
 * Refresh state.dictationDrafts (the lightweight chip summaries) for the
 * current workspace+room. Call on startup and whenever the composer switches
 * rooms; also called internally after any draft mutation.
 */
export async function refreshDictationDrafts() {
  const drafts = await draftsForCurrentRoom();
  state.dictationDrafts = drafts
    .filter((draft) => !(session && draft.id === session.draftId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((draft) => ({ id: draft.id, startedAt: draft.startedAt, durationMs: draft.durationMs, status: draft.status, error: draft.error }));
  markDirty("composer");
}

/**
 * Recovered drafts for the current workspace+room, with their audio
 * assembled FROM the chunks store (heavier than refreshDictationDrafts —
 * used when actually acting on a draft's audio, not for the chip summary).
 * @returns {Promise<RecoveredDraft[]>}
 */
export async function listRecoveredDrafts() {
  const drafts = await draftsForCurrentRoom();
  /** @type {RecoveredDraft[]} */
  const recovered = [];
  for (const draft of drafts) {
    if (session && draft.id === session.draftId) continue;
    const blob = await assembleClipFromChunks(draft.id, draft.mimeType);
    if (!blob) continue;
    recovered.push({ id: draft.id, startedAt: draft.startedAt, durationMs: draft.durationMs, blob, status: draft.status, error: draft.error });
  }
  return recovered.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Transcribe a recovered draft: assemble its audio from IndexedDB, POST it
 * via the same fetch path as a live recording. Success inserts the
 * transcript and deletes the draft+chunks; failure keeps the draft (with its
 * error) so it stays offered as a chip. Sets state.dictationBusy only while
 * its own fetch is in flight — never touches state.dictating, never disables
 * the mic or send.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function transcribeRecoveredDraft(id) {
  if (state.dictationBusy) return false;
  const draft = await getDraft(id);
  if (!draft) return false;
  const blob = await assembleClipFromChunks(id, draft.mimeType);
  if (!blob || !blob.size) {
    await updateDraft(id, { status: "failed", error: "no audio captured" });
    return false;
  }
  state.dictationBusy = true;
  markDirty("composer");
  try {
    const result = await postClip(blob);
    if (result.ok) {
      insertTranscript(result.text);
      await deleteDraftAndChunks(id);
      return true;
    }
    await updateDraft(id, { status: "failed", error: result.error });
    return false;
  } finally {
    state.dictationBusy = false;
    markDirty("composer");
  }
}

/** Explicit user discard of a recovered draft: deletes the draft row and its chunks.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function discardRecoveredDraft(id) {
  await deleteDraftAndChunks(id);
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

/** @returns {string} */
function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `d${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// IndexedDB durability layer. Every op below is best-effort: wrapped so a
// failure (unsupported browser, quota, private mode) never throws into the
// caller — recording/transcribing/sending all keep working purely in memory.

/** @type {Promise<IDBDatabase|null>|null} */
let dbPromise = null;

/** Lazily open (or create) the drafts database. @returns {Promise<IDBDatabase|null>} */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DRAFTS_STORE)) db.createObjectStore(DRAFTS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) db.createObjectStore(CHUNKS_STORE, { keyPath: ["draftId", "seq"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** @param {DraftRecord} draft @returns {Promise<boolean>} true when the row was persisted. */
async function putDraft(draft) {
  let ok = false;
  try {
    const db = await openDb();
    if (!db) return false;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, "readwrite");
      tx.objectStore(DRAFTS_STORE).put(draft);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    ok = true;
  } catch {
    ok = false;
  }
  void refreshDictationDrafts();
  return ok;
}

/** @param {ChunkRecord} chunk */
async function putChunk(chunk) {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNKS_STORE, "readwrite");
      tx.objectStore(CHUNKS_STORE).put(chunk);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort — the in-memory chunk (pushed before this call) stays primary.
  }
}

/** @param {string} id @returns {Promise<DraftRecord|null>} */
async function getDraft(id) {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, "readonly");
      const request = tx.objectStore(DRAFTS_STORE).get(id);
      request.onsuccess = () => resolve(/** @type {DraftRecord|undefined} */ (request.result) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/** @param {string} id @param {Partial<DraftRecord>} patch */
async function updateDraft(id, patch) {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, "readwrite");
      const store = tx.objectStore(DRAFTS_STORE);
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (existing) store.put({ ...existing, ...patch });
      };
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
  void refreshDictationDrafts();
}

/** @param {string} id */
async function deleteDraftAndChunks(id) {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction([DRAFTS_STORE, CHUNKS_STORE], "readwrite");
      tx.objectStore(DRAFTS_STORE).delete(id);
      const chunkStore = tx.objectStore(CHUNKS_STORE);
      const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
      const cursorRequest = chunkStore.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
  void refreshDictationDrafts();
}

/** @returns {Promise<DraftRecord[]>} draft rows for the current workspace+room. */
async function draftsForCurrentRoom() {
  try {
    const db = await openDb();
    if (!db) return [];
    const snapshot = state.snapshot;
    const roomId = snapshot?.room.id ?? "";
    const workspaceId = snapshot?.workspace.id ?? "";
    if (!roomId || !workspaceId) return [];
    /** @type {DraftRecord[]} */
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE, "readonly");
      const request = tx.objectStore(DRAFTS_STORE).getAll();
      request.onsuccess = () => resolve(/** @type {DraftRecord[]} */ (request.result ?? []));
      request.onerror = () => reject(request.error);
    });
    return all.filter((draft) => draft.roomId === roomId && draft.workspaceId === workspaceId);
  } catch {
    return [];
  }
}

/** @param {string} draftId @param {string} mimeType @returns {Promise<Blob|null>} */
async function assembleClipFromChunks(draftId, mimeType) {
  try {
    const db = await openDb();
    if (!db) return null;
    /** @type {ChunkRecord[]} */
    const chunks = await new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNKS_STORE, "readonly");
      const range = IDBKeyRange.bound([draftId, -Infinity], [draftId, Infinity]);
      const request = tx.objectStore(CHUNKS_STORE).getAll(range);
      request.onsuccess = () => resolve(/** @type {ChunkRecord[]} */ (request.result ?? []));
      request.onerror = () => reject(request.error);
    });
    if (!chunks.length) return null;
    chunks.sort((a, b) => a.seq - b.seq);
    return new Blob(
      chunks.map((chunk) => chunk.blob),
      { type: mimeType || "audio/webm" },
    );
  } catch {
    return null;
  }
}
