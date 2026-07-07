// Voice input (dictation): one recorded clip → text, uniformly across STT
// engines. This is the one-shot MIRROR of read-aloud.ts — read-aloud is
// text→speech (a message spoken), this is speech→text (a clip transcribed):
//   1. engine registry — engines register as DATA (id + transcribe), the shared
//      path never branches on an engine id (same law as harnesses and the TTS
//      engines in read-aloud.ts)
//   2. elevenlabs engine — the ElevenLabs "Scribe" API (reuses the TTS key)
//   3. openai engine — any OpenAI-compatible /audio/transcriptions endpoint,
//      hosted (OpenAI, Groq, …) OR a local whisper-server, so dictation can be
//      "either local or API" without touching the shared path
// Live-CALL STT is a different pipeline (services/voice.ts + the unmute stack):
// streaming and duplex. This module is one-shot: audio bytes in, text out.

import { elevenLabsKey, type VoiceSettings } from "./voice.js";

// ---------------------------------------------------------------------------
// Engine registry. An engine is DATA: an id plus a transcribe function over the
// uniform context. The shared transcribe path resolves engines from this
// registry only — adding an engine is one registerSttEngine call, and no shared
// code may ever branch on a specific engine id (RULE #0, same as TTS/harnesses).

/** A recorded clip to transcribe. The bytes come straight from the browser's
 * MediaRecorder (webm/opus, mp4, …) or any uploaded audio/video file. */
export interface SttAudioInput {
  data: Buffer;
  /** MIME type of the clip (from the recorder); drives the multipart filename. */
  contentType: string;
  /** Optional filename hint — some APIs sniff the container from its extension. */
  filename?: string;
}

export interface SttContext {
  audio: SttAudioInput;
  settings: VoiceSettings;
  /** Spoken-language hint (ISO 639 code); "" / undefined = auto-detect. */
  language?: string;
  log(message: string): void;
  /** Abort in-flight transcription (a client disconnect). */
  signal?: AbortSignal;
}

export interface SttResult {
  text: string;
}

export interface SttEngineSpec {
  id: string;
  /** Human label, surfaced in settings hints. */
  label: string;
  transcribe(context: SttContext): Promise<SttResult>;
}

const engines = new Map<string, SttEngineSpec>();

export function registerSttEngine(spec: SttEngineSpec): void {
  engines.set(spec.id, spec);
}

export function findSttEngine(id: string): SttEngineSpec | undefined {
  return engines.get(id);
}

export function sttEngineIds(): string[] {
  return [...engines.keys()];
}

/** The STT engine dictation uses: voice.json `sttEngine`, resolved from the
 * registry. Throws (never silently falls back) on an unknown id — same as
 * resolveTtsChoice. */
export function resolveSttEngine(settings: VoiceSettings): SttEngineSpec {
  const engine = findSttEngine(settings.sttEngine);
  if (!engine) throw new Error(`Unknown STT engine "${settings.sttEngine}" (available: ${sttEngineIds().join(", ")})`);
  return engine;
}

// ---------------------------------------------------------------------------
// The shared transcribe path (daemon calls this; the server owns the transport).

export interface TranscribeRequest {
  audio: SttAudioInput;
  settings: VoiceSettings;
  /** Per-request engine override (a ?engine= query); defaults to settings.sttEngine. */
  engineId?: string;
  /** Per-request language override; defaults to settings.sttLanguage. */
  language?: string;
  log?: (message: string) => void;
  signal?: AbortSignal;
}

export async function transcribe(request: TranscribeRequest): Promise<SttResult & { engine: string }> {
  if (!request.audio.data.length) throw new Error("No audio to transcribe");
  const engineId = request.engineId?.trim() || request.settings.sttEngine;
  const engine = findSttEngine(engineId);
  if (!engine) throw new Error(`Unknown STT engine "${engineId}" (available: ${sttEngineIds().join(", ")})`);

  const result = await engine.transcribe({
    audio: request.audio,
    settings: request.settings,
    language: request.language ?? request.settings.sttLanguage,
    log: request.log ?? (() => {}),
    signal: request.signal,
  });
  return { text: result.text.trim(), engine: engine.id };
}

// ---------------------------------------------------------------------------
// Multipart plumbing shared by the REST engines. Node (>=18) ships global
// FormData/Blob, and undici's fetch sets the multipart boundary itself — so an
// engine must NOT set its own content-type header, only its auth header.

const MIME_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/oga": "ogg",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

function audioFilename(audio: SttAudioInput): string {
  if (audio.filename?.trim()) return audio.filename.trim();
  const mime = (audio.contentType || "").split(";")[0].trim().toLowerCase();
  return `dictation.${MIME_EXT[mime] ?? "webm"}`;
}

/** A FormData carrying the clip as `file` plus the given text fields. */
function audioForm(audio: SttAudioInput, fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const type = (audio.contentType || "application/octet-stream").split(";")[0].trim();
  form.append("file", new Blob([audio.data], { type }), audioFilename(audio));
  return form;
}

const STT_TIMEOUT_MS = 120_000;

/** The clip's own signal, or a default timeout so a hung API can't wedge a turn. */
function sttSignal(context: SttContext): AbortSignal {
  return context.signal ?? AbortSignal.timeout(STT_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// elevenlabs — the ElevenLabs "Scribe" speech-to-text API. Same key as the TTS
// engine (elevenLabsKey), so once ElevenLabs is set up for read-aloud, dictation
// works with no extra config. POST multipart to /v1/speech-to-text; the JSON
// response's `text` is the transcript.

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

async function elevenLabsTranscribe(context: SttContext): Promise<SttResult> {
  const key = elevenLabsKey(context.settings);
  const model = context.settings.elevenLabsSttModel || "scribe_v1";
  const form = audioForm(context.audio, {
    model_id: model,
    ...(context.language?.trim() ? { language_code: context.language.trim() } : {}),
  });
  const response = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
    method: "POST",
    // Only the auth header — fetch adds the multipart content-type + boundary.
    headers: { "xi-api-key": key },
    body: form,
    signal: sttSignal(context),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs transcription failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = (await response.json()) as { text?: unknown };
  return { text: typeof data.text === "string" ? data.text : "" };
}

registerSttEngine({
  id: "elevenlabs",
  label: "ElevenLabs Scribe (API)",
  transcribe: elevenLabsTranscribe,
});

// ---------------------------------------------------------------------------
// openai — any OpenAI-compatible /audio/transcriptions endpoint. The base URL
// is configurable, so this one engine covers hosted Whisper (OpenAI, Groq, …)
// AND a local whisper-server — dictation can be "either local or API" by
// changing sttOpenAiBaseUrl alone, never the shared path. A localhost base URL
// may need no key; a remote one requires one.

function isLocalUrl(base: string): boolean {
  try {
    const host = new URL(base).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

async function openAiTranscribe(context: SttContext): Promise<SttResult> {
  const base = (context.settings.sttOpenAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const key = context.settings.sttOpenAiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  if (!key && !isLocalUrl(base)) {
    throw new Error("OpenAI STT API key not set (voice.json sttOpenAiApiKey or OPENAI_API_KEY env)");
  }
  const form = audioForm(context.audio, {
    model: context.settings.sttOpenAiModel || "whisper-1",
    ...(context.language?.trim() ? { language: context.language.trim() } : {}),
  });
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: form,
    signal: sttSignal(context),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = (await response.json()) as { text?: unknown };
  return { text: typeof data.text === "string" ? data.text : "" };
}

registerSttEngine({
  id: "openai",
  label: "OpenAI / Whisper (any OpenAI-compatible endpoint, incl. local)",
  transcribe: openAiTranscribe,
});
