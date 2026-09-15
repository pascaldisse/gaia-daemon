// voice.json call → ephemeral browser call parameters; never persisted session state.
export const VOICE_CALL_DEFAULTS = Object.freeze({
  rmsThreshold: 0.025,
  silenceMs: 900,
  minSpeechMs: 200,
  maxUtteranceMs: 30000,
  meterIntervalMs: 40,
  fftSize: 2048,
  transcriptionTimeoutMs: 60000,
  ttsEngine: "claude",
});
/** @param {unknown} raw */
export function voiceCallConfig(raw) {
  /** @type {import("./voice-call-config.js").VoiceCallConfig} */
  const config = { ...VOICE_CALL_DEFAULTS };
  if (!raw || typeof raw !== "object") return config;
  for (const key of /** @type {const} */ (["rmsThreshold", "silenceMs", "minSpeechMs", "maxUtteranceMs", "meterIntervalMs", "transcriptionTimeoutMs"])) {
    const value = /** @type {Record<string, unknown>} */ (raw)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) config[key] = value;
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const fft = input.fftSize;
  if (typeof fft === "number" && fft >= 32 && fft <= 32768 && Number.isInteger(Math.log2(fft))) config.fftSize = fft;
  if (typeof input.ttsEngine === "string" && input.ttsEngine.trim()) config.ttsEngine = input.ttsEngine.trim();
  return config;
}
