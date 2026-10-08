import { api } from "./api.js";
import { markDirty, setError } from "./render.js";
import { state } from "./state.js";
import { openDictationMicrophone, pickMimeType, postClip } from "./dictation.js";
import { startReadAloud, stopReadAloud } from "./tts.js";
import { VoiceCall } from "./voice-call.js";
import { voiceCallConfig } from "../shared/voice-call-config.js";

let config = voiceCallConfig(undefined);
const call = new VoiceCall({
  changed: (current) => {
    state.call = current ? { ...current.origin, startedAt: current.startedAt } : null;
    markDirty("composer", "status");
  },
  stopAudio: stopReadAloud,
  speak: (id, origin) => { void startReadAloud(id, false, origin, { engine: config.ttsEngine }); },
  error: setError,
  openMic: async (signal, text) => {
    const body = await api("/api/voice/call-settings", { signal });
    config = voiceCallConfig(body.call);
    if (signal.aborted) throw signal.reason;
    return openCallMicrophone(config, signal, text);
  },
  send: async (text, origin, signal) => {
    await api(`/api/workspaces/${encodeURIComponent(origin.workspaceId)}/rooms/${encodeURIComponent(origin.roomId)}/messages`, {
      method: "POST", body: JSON.stringify({ text }), signal,
    });
  },
});

export async function toggleCall() {
  if (call.current) { endCall(); return; }
  const snapshot = state.snapshot;
  if (!snapshot) return;
  if (state.dictating || state.dictationBusy) { setError("Finish dictation before starting a call."); return; }
  await call.start({ workspaceId: snapshot.workspace.id, roomId: snapshot.room.id }, snapshot.room.events.map((event) => event.id));
}
export function endCall() { call.end(); }
/** @param {import('./types.js').UiEvent} event */
export function callReply(event) { call.reply(event); }
export function syncCallRoom() {
  const snapshot = state.snapshot;
  call.navigate(snapshot ? { workspaceId: snapshot.workspace.id, roomId: snapshot.room.id } : null);
}
export function installVoiceLifecycle() {
  window.addEventListener("pagehide", endCall);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !call.current) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    endCall();
  }, true);
}

/** @param {ReturnType<typeof voiceCallConfig>} settings @param {AbortSignal} signal
 * @param {(text: string) => Promise<void>} send */
async function openCallMicrophone(settings, signal, send) {
  const stream = await openDictationMicrophone();
  if (signal.aborted) { stream.getTracks().forEach((track) => track.stop()); throw signal.reason; }
  /** @type {AudioContext|null} */ let context = null;
  /** @type {MediaRecorder|null} */ let recorder = null;
  /** @type {Blob[]} */ let chunks = [];
  let timer = 0;
  let busy = false;
  let speechMs = 0;
  let lastSpeech = 0;
  let started = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
    chunks = [];
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    context = new AudioContext();
    await context.resume();
    if (signal.aborted) { stop(); throw signal.reason; }
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = settings.fftSize;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const mimeType = pickMimeType();
    const speaking = () => state.readAloud?.phase === "loading" || state.readAloud?.phase === "playing";
    timer = window.setInterval(() => {
      if (stopped || busy) return;
      if (speaking()) {
        // Avoid transcribing our own loudspeaker output; no buffered turn survives playback.
        if (recorder?.state === "recording") { speechMs = 0; recorder.stop(); }
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      const now = performance.now();
      if (rms >= settings.rmsThreshold) {
        if (!recorder) {
          chunks = []; speechMs = 0; started = now;
          const current = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
          recorder = current;
          current.ondataavailable = (event) => { if (!stopped && event.data.size) chunks.push(event.data); };
          current.onerror = () => { if (!stopped) { endCall(); setError("Call microphone recording failed."); } };
          current.onstop = async () => {
            const clip = new Blob(chunks, { type: current.mimeType });
            const accepted = speechMs >= settings.minSpeechMs && !speaking();
            recorder = null; chunks = [];
            if (stopped || !accepted || !clip.size) return;
            busy = true;
            try {
              // Same raw dictation client; configured daemon STT engine; no queue/retry path.
              const result = await postClip(clip, AbortSignal.any([signal, AbortSignal.timeout(settings.transcriptionTimeoutMs)]));
              if (stopped || signal.aborted) return;
              if (!result.ok) throw new Error(result.error);
              await send(result.text);
            } catch (error) {
              if (!stopped) { endCall(); setError(error); }
            } finally { busy = false; }
          };
          current.start();
        }
        speechMs += settings.meterIntervalMs;
        lastSpeech = now;
      }
      if (recorder?.state === "recording" && (now - lastSpeech >= settings.silenceMs || now - started >= settings.maxUtteranceMs)) recorder.stop();
    }, settings.meterIntervalMs);
    for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (!stopped) { endCall(); setError("Call microphone disconnected."); } });
    return stop;
  } catch (error) { stop(); throw error; }
}
