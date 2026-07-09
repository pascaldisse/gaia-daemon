// Composer dictation (voice INPUT): the mic button records a short clip, the
// daemon transcribes it (ElevenLabs Scribe by default; the STT engine is
// swappable in voice.json), and the text lands in the composer. This is the
// one-shot mirror of read-aloud; live-CALL STT is the separate streaming path
// in voice.js (which writes the composer as the agent hears you).
//
// Durability rule: a recording is written into IndexedDB as a local audio draft
// while it is being captured. Transcription may fail, the daemon may restart,
// or the tab may reload; the audio draft stays available for retry/discard.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

const DB_NAME = "gaia-dictation-drafts";
const DB_VERSION = 1;
const CLIP_STORE = "clips";
const CHUNK_STORE = "chunks";
const WAVE_BARS = 28;

/** @typedef {"recording"|"saved"|"transcribing"|"failed"|"transcribed"} DraftStatus */
/**
 * @typedef {Object} DictationDraft
 * @property {string} id
 * @property {string} workspaceId
 * @property {string} roomId
 * @property {string} startedAt
 * @property {string} updatedAt
 * @property {string} mimeType
 * @property {DraftStatus} status
 * @property {number} bytes
 * @property {number} durationMs
 * @property {string} error
 */
/**
 * @typedef {Object} StoredChunk
 * @property {string} key
 * @property {string} draftId
 * @property {number} seq
 * @property {Blob} data
 */
/**
 * @typedef {Object} DictationSession
 * @property {MediaRecorder} recorder
 * @property {MediaStream} stream
 * @property {string} draftId
 * @property {string} mimeType
 * @property {number} seq
 * @property {number} bytes
 * @property {number} startedAtMs
 * @property {Promise<void>[]} chunkWrites
 * @property {boolean} canceled
 * @property {boolean} deferTranscription
 * @property {boolean} stopRequested
 * @property {boolean} cacheFailed
 * @property {boolean} finished
 * @property {number} finishWatchdog
 * @property {string} error
 * @property {AudioContext|null} audioContext
 * @property {AnalyserNode|null} analyser
 * @property {Uint8Array|null} analyserData
 * @property {number} raf
 * @property {(ok: boolean) => void} resolveFinish
 * @property {Promise<boolean>} finishPromise
 */

/** @type {DictationSession|null} */
let session = null;
/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;
/** @type {string|null} */
let restoredRoomKey = null;
/** @type {boolean} */
let restoring = false;
/** @type {Promise<boolean>|null} */
let activeTranscriptionPromise = null;

/** Toggle recording: start if idle, else stop-and-transcribe. */
export async function toggleDictation() {
  if (session) {
    await stopDictation();
    return;
  }
  await startDictation();
}

/** @returns {boolean} */
export function hasPendingDictation() {
  return Boolean(session || state.dictationBusy || (state.dictationDraft && state.dictationDraft.status !== "transcribed"));
}

/**
 * Used by the main send action. If the user presses Enter/send while a clip is
 * recording or saved, stop it if needed, transcribe the durable draft, insert
 * the text into the composer, and report whether normal send may continue.
 * @returns {Promise<boolean>}
 */
export async function finalizeDictationForSend() {
  if (session) return await stopDictation();
  if (state.dictationBusy) return activeTranscriptionPromise ? await activeTranscriptionPromise : false;
  const draft = state.dictationDraft;
  if (!draft) return true;
  return await transcribeDraft(draft.id);
}

/** Delete a successfully-transcribed audio draft after its message was accepted. */
export async function clearTranscribedDictationDraft() {
  const draft = state.dictationDraft;
  if (!draft || draft.status !== "transcribed") return;
  await deleteDraft(draft.id).catch((error) => setError(error));
  if (state.dictationDraft?.id === draft.id) state.dictationDraft = null;
  markDirty("composer");
}

/** Discard the current durable audio draft. Explicit user action only. */
export async function discardDictationDraft() {
  if (session) {
    await cancelDictation();
    return;
  }
  const draft = state.dictationDraft;
  if (!draft) return;
  await deleteDraft(draft.id).catch((error) => setError(error));
  state.dictationDraft = null;
  state.dictationBusy = false;
  state.dictating = false;
  markDirty("composer");
}

/** Restore a saved/interrupted clip for the currently open room, if one exists. */
export async function restoreDictationDraftForCurrentRoom() {
  const snapshot = state.snapshot;
  if (!snapshot || session || state.dictationBusy || restoring) return;
  const key = `${snapshot.workspace.id}::${snapshot.room.id}`;
  if (restoredRoomKey === key) return;
  restoredRoomKey = key;
  restoring = true;
  try {
    const draft = await latestDraftForRoom(snapshot.workspace.id, snapshot.room.id);
    state.dictationDraft = draft;
    state.dictating = Boolean(draft && draft.status === "recording");
    state.dictationBusy = Boolean(draft && draft.status === "transcribing");
    if (draft && !state.dictationBars.length) state.dictationBars = flatBars();
    markDirty("composer");
  } catch (error) {
    setError(error);
  } finally {
    restoring = false;
  }
}

async function startDictation() {
  // A live call already transcribes speech into the composer; a second mic
  // stream would just fight it.
  if (state.voice) {
    setError(new Error(`You're on a call with @${state.voice.agentId} — just speak, it transcribes live.`));
    return;
  }
  const snapshot = state.snapshot;
  if (!snapshot) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setError(new Error("This browser can't record audio (no MediaRecorder / microphone access)."));
    return;
  }

  // Refuse to record if the durable cache is unavailable. Recording unsafely is
  // worse than failing early because it recreates the exact data-loss path this
  // feature is meant to remove.
  try {
    await openDraftDb();
  } catch (error) {
    setError(new Error(`Can't start recording because the durable audio cache is unavailable: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }

  /** @type {MediaStream} */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    setError(new Error("Microphone permission denied or no microphone available."));
    return;
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const now = new Date().toISOString();
  const draft = /** @type {DictationDraft} */ ({
    id: `dict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    workspaceId: snapshot.workspace.id,
    roomId: snapshot.room.id,
    startedAt: now,
    updatedAt: now,
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    status: "recording",
    bytes: 0,
    durationMs: 0,
    error: "",
  });
  try {
    await putDraft(draft);
  } catch (error) {
    stopStreamTracks(stream);
    setError(new Error(`Can't start recording because the audio draft could not be cached: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }

  /** @type {(ok: boolean) => void} */
  let resolveFinish = () => {};
  const finishPromise = new Promise((resolve) => {
    resolveFinish = resolve;
  });
  /** @type {DictationSession} */
  const current = {
    recorder,
    stream,
    draftId: draft.id,
    mimeType: draft.mimeType,
    seq: 0,
    bytes: 0,
    startedAtMs: Date.now(),
    chunkWrites: [],
    canceled: false,
    deferTranscription: false,
    stopRequested: false,
    cacheFailed: false,
    finished: false,
    finishWatchdog: 0,
    error: "",
    audioContext: null,
    analyser: null,
    analyserData: null,
    raf: 0,
    resolveFinish,
    finishPromise,
  };
  session = current;
  state.dictating = true;
  state.dictationBusy = false;
  state.dictationDraft = draft;
  state.dictationBars = flatBars();
  state.dictationLevel = 0;

  recorder.ondataavailable = (event) => {
    if (!event.data || !event.data.size) return;
    const seq = current.seq++;
    current.bytes += event.data.size;
    const durationMs = Math.max(0, Date.now() - current.startedAtMs);
    const status = /** @type {DraftStatus} */ (current.stopRequested ? (current.deferTranscription ? "saved" : "transcribing") : "recording");
    updateStateDraft({ bytes: current.bytes, durationMs, updatedAt: new Date().toISOString(), status, error: "" });
    const write = putChunk(current.draftId, seq, event.data)
      .then(() => updateStoredDraft(current.draftId, { bytes: current.bytes, durationMs, updatedAt: new Date().toISOString(), status, error: "" }))
      .catch((error) => {
        current.cacheFailed = true;
        current.error = `Audio cache write failed: ${error instanceof Error ? error.message : String(error)}`;
        setError(new Error(`${current.error}. Recording was stopped so the clip can be retried safely.`));
        requestStop(current);
      });
    current.chunkWrites.push(write);
  };
  recorder.onstop = () => void finish(current);
  recorder.onerror = () => {
    current.error = "Recording failed.";
    requestStop(current);
  };

  startMeter(current);
  recorder.start(500);
  markDirty("composer");
}

/** Stop recording and transcribe what was captured. @returns {Promise<boolean>} */
function stopDictation() {
  const current = session;
  if (!current) return Promise.resolve(false);
  state.dictating = false;
  state.dictationBusy = true;
  updateStateDraft({ status: "transcribing", updatedAt: new Date().toISOString(), error: "" });
  markDirty("composer");
  requestStop(current);
  return current.finishPromise;
}

/** Abort recording and delete the draft. Explicit user discard only. */
export async function cancelDictation() {
  const current = session;
  if (!current) return;
  current.canceled = true;
  state.dictating = false;
  state.dictationBusy = false;
  markDirty("composer");
  requestStop(current);
  await current.finishPromise;
}

/** @param {DictationSession} current */
async function finish(current) {
  if (current.finished) return;
  current.finished = true;
  if (current.finishWatchdog) {
    clearTimeout(current.finishWatchdog);
    current.finishWatchdog = 0;
  }
  if (session && session !== current) {
    current.resolveFinish(false);
    return;
  }
  session = null;
  stopMeter(current);
  stopStreamTracks(current.stream);
  await waitForChunkWrites(current, 1200);

  if (current.canceled) {
    await deleteDraft(current.draftId).catch((error) => setError(error));
    if (state.dictationDraft?.id === current.draftId) state.dictationDraft = null;
    state.dictationBusy = false;
    state.dictating = false;
    markDirty("composer");
    current.resolveFinish(false);
    return;
  }

  const durationMs = Math.max(state.dictationDraft?.durationMs ?? 0, Date.now() - current.startedAtMs);
  if (current.deferTranscription) {
    await updateStoredDraft(current.draftId, { status: "saved", durationMs, updatedAt: new Date().toISOString(), error: "Recording stopped before the page closed; audio was kept locally." }).catch((error) => setError(error));
    updateStateDraft({ status: "saved", durationMs, updatedAt: new Date().toISOString(), error: "Recording stopped before the page closed; audio was kept locally." });
    state.dictationBusy = false;
    state.dictating = false;
    markDirty("composer");
    current.resolveFinish(false);
    return;
  }

  if (current.cacheFailed || current.error) {
    const error = current.error || "Recording failed.";
    await updateStoredDraft(current.draftId, { status: "failed", durationMs, updatedAt: new Date().toISOString(), error }).catch((err) => setError(err));
    updateStateDraft({ status: "failed", durationMs, updatedAt: new Date().toISOString(), error });
    state.dictationBusy = false;
    state.dictating = false;
    markDirty("composer");
    current.resolveFinish(false);
    return;
  }

  const ok = await transcribeDraft(current.draftId);
  current.resolveFinish(ok);
}

/** @param {DictationSession} current @param {number} timeoutMs */
async function waitForChunkWrites(current, timeoutMs) {
  if (current.chunkWrites.length === 0) return;
  await Promise.race([
    Promise.allSettled(current.chunkWrites),
    new Promise((resolve) => window.setTimeout(resolve, timeoutMs)),
  ]);
}

/** @param {string} draftId @returns {Promise<boolean>} */
export async function transcribeDraft(draftId) {
  if (activeTranscriptionPromise) return await activeTranscriptionPromise;
  activeTranscriptionPromise = runTranscribeDraft(draftId);
  try {
    return await activeTranscriptionPromise;
  } finally {
    activeTranscriptionPromise = null;
  }
}

/** @param {string} draftId @returns {Promise<boolean>} */
async function runTranscribeDraft(draftId) {
  state.dictationBusy = true;
  state.dictating = false;
  updateStateDraft({ status: "transcribing", error: "", updatedAt: new Date().toISOString() });
  await updateStoredDraft(draftId, { status: "transcribing", error: "", updatedAt: new Date().toISOString() }).catch(() => {});
  markDirty("composer");
  try {
    const meta = await getDraft(draftId);
    if (!meta) throw new Error("Audio draft is missing from the local cache.");
    const blob = await draftBlob(meta);
    if (!blob.size) throw new Error("No audio was captured; the empty draft was kept so you can discard it explicitly.");
    const text = await transcribeBlob(blob);
    if (!text) throw new Error("Transcription returned no text; audio kept locally for retry.");
    insertTranscript(text);
    const updated = /** @type {Partial<DictationDraft>} */ ({ status: "transcribed", error: "", updatedAt: new Date().toISOString() });
    await updateStoredDraft(draftId, updated);
    updateStateDraft(updated);
    state.dictationBars = flatBars();
    state.dictationLevel = 0;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(error);
    await updateStoredDraft(draftId, { status: "failed", error: message, updatedAt: new Date().toISOString() }).catch(() => {});
    updateStateDraft({ status: "failed", error: message, updatedAt: new Date().toISOString() });
    return false;
  } finally {
    state.dictationBusy = false;
    state.dictating = false;
    markDirty("composer");
  }
}

/**
 * POST the clip to the daemon and return the transcript. Not via api.js: the
 * body is raw audio, not JSON, so the content-type must be the clip's MIME.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function transcribeBlob(blob) {
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Transcription failed: ${response.status}`);
  return String(data.text ?? "").trim();
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
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(current.stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    current.audioContext = audioContext;
    current.analyser = analyser;
    current.analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    pumpMeter(current);
  } catch {
    // Meter is visual only; durable recording still works.
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
  const next = [...state.dictationBars.slice(-WAVE_BARS + 1), Math.max(0.04, rms)];
  state.dictationBars = next;
  state.dictationLevel = rms;
  updateStateDraft({ durationMs: Math.max(0, Date.now() - current.startedAtMs), bytes: current.bytes });
  markDirty("composer");
  current.raf = requestAnimationFrame(() => pumpMeter(current));
}

/** @param {DictationSession} current */
function stopMeter(current) {
  if (current.raf) cancelAnimationFrame(current.raf);
  void current.audioContext?.close().catch(() => {});
  current.audioContext = null;
  current.analyser = null;
  current.analyserData = null;
}

/** @param {Partial<DictationDraft>} patch */
function updateStateDraft(patch) {
  if (!state.dictationDraft) return;
  state.dictationDraft = { ...state.dictationDraft, ...patch };
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

/** @param {DictationSession} current */
function safeRequestData(current) {
  try {
    if (current.recorder.state === "recording") current.recorder.requestData();
  } catch {
    // Some engines throw if no data is ready; the periodic chunks are already cached.
  }
}

/** @param {DictationSession} current */
function requestStop(current) {
  current.stopRequested = true;
  safeRequestData(current);
  try {
    if (current.recorder.state !== "inactive") current.recorder.stop();
    else void finish(current);
  } catch {
    void finish(current);
    return;
  }
  // WKWebView/Safari can occasionally fail to deliver `onstop` after a manual
  // stop even though periodic chunks were already durably written. Do not leave
  // the UI in an eternal busy state: after a short grace window, finish from the
  // cached chunks. A late real onstop is ignored by the `finished` guard.
  current.finishWatchdog = window.setTimeout(() => void finish(current), 1500);
}

/** @returns {Promise<IDBDatabase>} */
function openDraftDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CLIP_STORE)) db.createObjectStore(CLIP_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
        chunks.createIndex("draftId", "draftId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open IndexedDB"));
  });
  return dbPromise;
}

/** @param {IDBRequest} request @returns {Promise<unknown>} */
function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** @param {IDBTransaction} tx @returns {Promise<void>} */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** @param {DictationDraft} draft */
async function putDraft(draft) {
  const db = await openDraftDb();
  const tx = db.transaction(CLIP_STORE, "readwrite");
  tx.objectStore(CLIP_STORE).put(draft);
  await transactionDone(tx);
}

/** @param {string} id @returns {Promise<DictationDraft|null>} */
async function getDraft(id) {
  const db = await openDraftDb();
  const tx = db.transaction(CLIP_STORE, "readonly");
  const done = transactionDone(tx);
  const result = await requestDone(tx.objectStore(CLIP_STORE).get(id));
  await done;
  return result ? /** @type {DictationDraft} */ (result) : null;
}

/** @param {string} id @param {Partial<DictationDraft>} patch */
async function updateStoredDraft(id, patch) {
  const current = await getDraft(id);
  if (!current) return;
  await putDraft({ ...current, ...patch });
}

/** @param {string} draftId @param {number} seq @param {Blob} data */
async function putChunk(draftId, seq, data) {
  const db = await openDraftDb();
  const tx = db.transaction(CHUNK_STORE, "readwrite");
  tx.objectStore(CHUNK_STORE).put({ key: `${draftId}:${seq.toString().padStart(6, "0")}`, draftId, seq, data });
  await transactionDone(tx);
}

/** @param {DictationDraft} draft @returns {Promise<Blob>} */
async function draftBlob(draft) {
  const db = await openDraftDb();
  const tx = db.transaction(CHUNK_STORE, "readonly");
  const done = transactionDone(tx);
  const chunks = /** @type {StoredChunk[]} */ (await requestDone(tx.objectStore(CHUNK_STORE).index("draftId").getAll(IDBKeyRange.only(draft.id))));
  await done;
  chunks.sort((a, b) => a.seq - b.seq);
  return new Blob(chunks.map((chunk) => chunk.data), { type: draft.mimeType || "audio/webm" });
}

/** @param {string} draftId */
async function deleteDraft(draftId) {
  const db = await openDraftDb();
  const readTx = db.transaction(CHUNK_STORE, "readonly");
  const readDone = transactionDone(readTx);
  const keys = /** @type {IDBValidKey[]} */ (await requestDone(readTx.objectStore(CHUNK_STORE).index("draftId").getAllKeys(IDBKeyRange.only(draftId))));
  await readDone;

  const tx = db.transaction([CLIP_STORE, CHUNK_STORE], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(CLIP_STORE).delete(draftId);
  const chunkStore = tx.objectStore(CHUNK_STORE);
  for (const key of keys) chunkStore.delete(key);
  await done;
}

/** @param {string} workspaceId @param {string} roomId @returns {Promise<DictationDraft|null>} */
async function latestDraftForRoom(workspaceId, roomId) {
  const db = await openDraftDb();
  const tx = db.transaction(CLIP_STORE, "readonly");
  const done = transactionDone(tx);
  const all = /** @type {DictationDraft[]} */ (await requestDone(tx.objectStore(CLIP_STORE).getAll()));
  await done;
  const matches = all
    .filter((draft) => draft.workspaceId === workspaceId && draft.roomId === roomId)
    .filter((draft) => draft.status === "saved" || draft.status === "failed" || draft.status === "recording" || draft.status === "transcribing" || draft.status === "transcribed")
    .sort((a, b) => Date.parse(b.updatedAt || b.startedAt) - Date.parse(a.updatedAt || a.startedAt));
  const draft = matches[0] ?? null;
  if (draft?.status === "recording" || draft?.status === "transcribing") {
    const error = draft.status === "recording" ? "Recording was interrupted; cached audio is ready to transcribe." : "Transcription was interrupted; cached audio is ready to retry.";
    const saved = /** @type {DictationDraft} */ ({ ...draft, status: "saved", error, updatedAt: new Date().toISOString() });
    await putDraft(saved);
    return saved;
  }
  return draft;
}

export function installDictationLifecycle() {
  window.addEventListener("pagehide", () => {
    if (!session) return;
    // Do not cancel/delete. Flush whatever the browser will give us, stop the
    // mic, and leave the durable draft behind for the next load.
    session.deferTranscription = true;
    requestStop(session);
  });
}
