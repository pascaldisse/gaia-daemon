// Composer dictation (voice INPUT): the mic button records a short clip, the
// daemon transcribes it (ElevenLabs Scribe by default; the STT engine is
// swappable in voice.json), and the text lands in the composer. This is the
// one-shot mirror of read-aloud; live-CALL STT is the separate streaming path
// in voice.js (which writes the composer as the agent hears you). Recording is
// per-tab and never leaves this module — only the finished clip is uploaded.
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

/**
 * @typedef {Object} DictationSession
 * @property {MediaRecorder} recorder
 * @property {MediaStream} stream
 * @property {Blob[]} chunks
 * @property {boolean} canceled
 */

/** @type {DictationSession|null} */
let session = null;

/** Toggle recording: start if idle, else stop-and-transcribe. */
export async function toggleDictation() {
  if (session) {
    stopDictation();
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
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setError(new Error("This browser can't record audio (no MediaRecorder / microphone access)."));
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
  /** @type {DictationSession} */
  const current = { recorder, stream, chunks: [], canceled: false };
  session = current;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) current.chunks.push(event.data);
  };
  recorder.onstop = () => void finish(current);
  recorder.onerror = () => {
    current.canceled = true;
    setError(new Error("Recording failed."));
    try {
      recorder.stop();
    } catch {
      void finish(current);
    }
  };
  recorder.start();
  state.dictating = true;
  state.dictationBusy = false;
  markDirty("composer");
}

/** Stop recording and transcribe what was captured. */
function stopDictation() {
  const current = session;
  if (!current) return;
  state.dictating = false;
  state.dictationBusy = true;
  markDirty("composer");
  try {
    current.recorder.stop();
  } catch {
    void finish(current);
  }
}

/** Abort recording without transcribing (Esc). */
export function cancelDictation() {
  const current = session;
  if (!current) return;
  current.canceled = true;
  state.dictating = false;
  state.dictationBusy = false;
  markDirty("composer");
  try {
    current.recorder.stop();
  } catch {
    stopTracks(current);
    session = null;
  }
}

/** @param {DictationSession} current */
async function finish(current) {
  // A newer session superseded this one (shouldn't happen — stop is exclusive).
  if (session && session !== current) return;
  session = null;
  stopTracks(current);

  if (current.canceled) {
    state.dictationBusy = false;
    markDirty("composer");
    return;
  }

  const type = current.recorder.mimeType || current.chunks[0]?.type || "audio/webm";
  const blob = new Blob(current.chunks, { type });
  if (!blob.size) {
    state.dictationBusy = false;
    markDirty("composer");
    return;
  }

  try {
    const text = await transcribeBlob(blob);
    if (text) insertTranscript(text);
  } catch (error) {
    setError(error);
  } finally {
    state.dictationBusy = false;
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
function stopTracks(current) {
  for (const track of current.stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Track already ended.
    }
  }
}

export function installDictationLifecycle() {
  // Closing/hiding the tab mid-record must release the mic.
  window.addEventListener("pagehide", () => {
    if (session) cancelDictation();
  });
}
