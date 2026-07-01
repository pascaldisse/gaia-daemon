// Voice calls. GAIA stays the brain — the server's /v1/chat/completions shim
// runs every spoken turn through the normal room/agent pipeline — while this
// module is the mouth and ears: it connects straight to the unmute backend,
// streams mic audio out as opus, plays TTS audio back, and renders the live
// speech transcription into the composer. Opus worklets load from ./vendor/.
import { api } from "./api.js";
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").VoiceCallInfo} VoiceCallInfo */
/** @typedef {import("./types.js").Ev<"voice-status">} VoiceStatusPayload */

/**
 * Audio/network session for a call started in this tab. Other tabs see the
 * same call via state.voice but have no audio.
 * @typedef {Object} VoiceSession
 * @property {WebSocket|null} ws
 * @property {AudioContext} audioContext
 * @property {any} recorder
 * @property {Worker|null} decoder
 * @property {AudioWorkletNode} outputWorklet
 * @property {number} micSamples
 */

/** @type {VoiceSession|null} */
let session = null;
let pendingTranscript = "";

/**
 * Muting keeps the opus stream flowing (unmute's timing depends on a
 * continuous audio clock) but at zero gain, so the STT hears silence.
 * @param {boolean} muted
 */
export function setMicMuted(muted) {
  state.micMuted = Boolean(muted);
  try {
    session?.recorder?.setRecordingGain(muted ? 0 : 1);
  } catch {
    // No live recorder; the flag still applies when one starts.
  }
  markDirty("composer");
}

/** @param {string} agentId */
export async function toggleCall(agentId) {
  if (state.voice?.agentId === agentId) {
    await endCall();
    return;
  }
  if (state.voice) {
    setError(`Already on a call with @${state.voice.agentId}. Hang up first.`);
    return;
  }
  await startCall(agentId);
}

/** @param {string} agentId */
async function startCall(agentId) {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  let bound = false;
  try {
    state.voicePendingAgentId = agentId;
    markDirty("panel", "status");
    const body = await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/voice/start`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
    bound = true;
    state.voice = body.voice;
    await openVoiceSession(body.voice);
    state.voicePendingAgentId = null;
    state.voiceStatusText = "";
    state.error = "";
    markDirty("panel", "status", "composer");
  } catch (error) {
    teardownAudio();
    state.voicePendingAgentId = null;
    state.voiceStatusText = "";
    state.voice = null;
    // Only release the binding we actually acquired — a failed start must
    // not hang up a call that belongs to another tab.
    if (bound) {
      void api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/voice/stop`, { method: "POST", body: "{}" }).catch(() => {});
    }
    markDirty("panel", "composer");
    setError(error);
  }
}

export async function endCall() {
  teardownAudio();
  pendingTranscript = "";
  state.voicePendingAgentId = null;
  state.voiceStatusText = "";
  state.micMuted = false;
  const hadCall = state.voice;
  state.voice = null;
  state.composerText = "";
  markDirty("panel", "status", "composer");
  const snapshot = state.snapshot;
  if (snapshot && hadCall) {
    try {
      await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/voice/stop`, { method: "POST", body: "{}" });
    } catch {
      // The binding expires with the server; nothing else to clean up.
    }
  }
}

/**
 * Server broadcast (voice-status SSE): keeps every tab's indicator in sync,
 * shows voice-stack startup progress, and tears down audio if the call was
 * ended elsewhere.
 * @param {VoiceStatusPayload} payload
 */
export function applyVoiceStatus(payload) {
  const voice = payload.voice ?? null;
  if (payload.pending) {
    state.voicePendingAgentId = payload.pending.agentId;
    state.voiceStatusText = payload.pending.message;
    markDirty("panel", "status");
    return;
  }

  state.voice = voice;
  state.voiceStatusText = "";
  if (voice) {
    state.voicePendingAgentId = null;
  } else {
    if (session) {
      teardownAudio();
      pendingTranscript = "";
      state.composerText = "";
    }
    state.voicePendingAgentId = null;
  }
  markDirty("panel", "status", "composer");
}

/**
 * Called when the user's spoken turn lands in the room transcript: the
 * pending live transcription has been committed, so clear the composer.
 */
export function voiceTurnCommitted() {
  if (!pendingTranscript) return;
  pendingTranscript = "";
  state.composerText = "";
  markDirty("composer");
}

export function installVoiceLifecycle() {
  window.addEventListener("pagehide", () => {
    const snapshot = state.snapshot;
    if (session && snapshot) {
      navigator.sendBeacon(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/voice/stop`, "{}");
    }
    teardownAudio();
  });
}

/** @param {VoiceCallInfo} call */
async function openVoiceSession(call) {
  const audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("./vendor/audio-output-processor.js");
  const outputWorklet = new AudioWorkletNode(audioContext, "audio-output-processor");
  outputWorklet.connect(audioContext.destination);
  outputWorklet.port.onmessage = () => {};

  /** @type {VoiceSession} */
  const current = { ws: null, audioContext, recorder: null, decoder: null, outputWorklet, micSamples: 0 };
  session = current;

  const decoder = new Worker("./vendor/decoderWorker.min.js");
  current.decoder = decoder;
  decoder.onmessage = (event) => {
    if (!event.data) return;
    // Opus always runs at 48kHz, so the recorder's sample position is /48000.
    outputWorklet.port.postMessage({ type: "audio", frame: event.data[0], micDuration: current.micSamples / 48000 });
  };
  decoder.postMessage({
    command: "init",
    bufferLength: (960 * audioContext.sampleRate) / 24000,
    decoderSampleRate: 24000,
    outputBufferSampleRate: audioContext.sampleRate,
    resampleQuality: 0,
  });

  const ws = new WebSocket(realtimeUrl(call.unmuteUrl), ["realtime"]);
  current.ws = ws;
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`unmute backend did not answer at ${call.unmuteUrl}`)), 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to unmute at ${call.unmuteUrl} - check ~/.gaia/logs/voice/ for service logs`));
      };
    })
  );
  ws.onerror = () => {};
  ws.onmessage = (event) => handleVoiceMessage(JSON.parse(String(event.data)));
  ws.onclose = () => {
    if (session === current) void endCall();
  };

  // unmute waits for session.update before doing anything, then has the
  // agent greet first (via the chat-completions shim, like every turn).
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        instructions: { type: "constant", text: "You are connected to a GAIA agent. The agent decides every response." },
        voice: call.voice ?? null,
        allow_recording: false,
      },
    }),
  );

  const Recorder = /** @type {any} */ (window).Recorder;
  const recorder = new Recorder({
    mediaTrackConstraints: {
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
      video: false,
    },
    encoderPath: "./vendor/encoderWorker.min.js",
    bufferLength: Math.round((960 * audioContext.sampleRate) / 24000),
    encoderFrameSize: 20,
    encoderSampleRate: 24000,
    maxFramesPerPage: 2,
    numberOfChannels: 1,
    recordingGain: 1,
    resampleQuality: 3,
    encoderComplexity: 0,
    encoderApplication: 2049,
    streamPages: true,
  });
  recorder.ondataavailable = (/** @type {Uint8Array} */ data) => {
    current.micSamples = recorder.encodedSamplePosition;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Encode(data) }));
    }
  };
  current.recorder = recorder;
  await audioContext.resume();
  await recorder.start();
  state.micMuted = false;
}

/** @param {any} data */
function handleVoiceMessage(data) {
  if (data.type === "response.audio.delta") {
    const bytes = base64Decode(data.delta);
    session?.decoder?.postMessage({ command: "decode", pages: bytes }, [bytes.buffer]);
    return;
  }
  if (data.type === "conversation.item.input_audio_transcription.delta") {
    appendTranscriptionDelta(data.delta);
    return;
  }
  if (data.type === "unmute.interrupted_by_vad") {
    // The user talked over the agent: drop whatever TTS audio is buffered.
    session?.outputWorklet.port.postMessage({ type: "reset" });
    return;
  }
  if (data.type === "error") {
    if (data.error?.type === "warning") {
      console.warn("unmute warning:", data.error?.message);
      return;
    }
    setError(`Voice error: ${data.error?.message ?? "unknown"}`);
    void endCall();
  }
}

/** @param {unknown} delta */
function appendTranscriptionDelta(delta) {
  const word = String(delta ?? "").trim();
  if (!word) return;
  pendingTranscript = pendingTranscript ? `${pendingTranscript} ${word}` : word;
  state.composerText = pendingTranscript;
  markDirty("composer");
}

function teardownAudio() {
  const current = session;
  if (!current) return;
  session = null;
  try {
    if (current.ws) {
      current.ws.onclose = null;
      current.ws.close();
    }
  } catch {
    // Already closed.
  }
  try {
    current.recorder?.stop();
  } catch {
    // Recorder was never started.
  }
  try {
    current.decoder?.terminate();
  } catch {
    // Worker already gone.
  }
  try {
    current.outputWorklet.disconnect();
  } catch {
    // Worklet already disconnected.
  }
  void current.audioContext.close().catch(() => {});
}

/** @param {string} unmuteUrl */
function realtimeUrl(unmuteUrl) {
  const base = String(unmuteUrl).replace(/^http/, "ws").replace(/\/+$/, "");
  return `${base}/v1/realtime`;
}

/** @param {Uint8Array} bytes */
function base64Encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return window.btoa(binary);
}

/** @param {string} value */
function base64Decode(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
