export interface VoiceCallConfig {
  rmsThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  meterIntervalMs: number;
  fftSize: number;
  transcriptionTimeoutMs: number;
  ttsEngine: string;
}
export const VOICE_CALL_DEFAULTS: Readonly<VoiceCallConfig>;
export function voiceCallConfig(raw: unknown): VoiceCallConfig;
