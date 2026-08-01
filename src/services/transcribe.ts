// Voice input (dictation): one recorded clip → text, uniformly across STT
// engines. This is the one-shot MIRROR of read-aloud.ts — read-aloud is
// text→speech (a message spoken), this is speech→text (a clip transcribed):
//   1. engine registry — engines register as DATA (id + transcribe), the shared
//      path never branches on an engine id (same law as harnesses and the TTS
//      engines in read-aloud.ts)
//   2. replicate engine — hosted Whisper predictions over Replicate's HTTP API
//   3. elevenlabs engine — the ElevenLabs "Scribe" API (reuses the TTS key)
//   4. openai engine — any OpenAI-compatible /audio/transcriptions endpoint,
//      hosted (OpenAI, Groq, …) OR a local whisper-server, so dictation can be
//      "either local or API" without touching the shared path
// Live-CALL STT is a different pipeline (services/voice.ts + the unmute stack):
// streaming and duplex. This module is one-shot: audio bytes in, text out.

import { elevenLabsKey, replicateKey, type VoiceSettings } from "./voice.js";

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
// replicate — hosted Whisper through Replicate predictions. Audio is sent as a
// data URL so browser-recorded clips need no public upload URL. `Prefer: wait`
// usually yields a completed prediction; a GET poll handles longer clips.

const REPLICATE_BASE = "https://api.replicate.com/v1";
const REPLICATE_WAIT_SECONDS = 60;
const REPLICATE_POLL_MS = 1_000;

type ReplicatePrediction = {
  status?: unknown;
  output?: unknown;
  error?: unknown;
  urls?: { get?: unknown };
};

function replicateModelUrl(model: string): string {
  const [owner, name, ...rest] = model.trim().split("/");
  if (!owner || !name || rest.length) throw new Error(`Invalid Replicate model "${model}" (expected owner/name)`);
  return `${REPLICATE_BASE}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function replicateAudioDataUrl(audio: SttAudioInput): string {
  const type = (audio.contentType || "application/octet-stream").split(";", 1)[0].trim() || "application/octet-stream";
  return `data:${type};base64,${audio.data.toString("base64")}`;
}

function replicateLanguage(language?: string): string {
  const names: Record<string, string> = {
    en: "english", de: "german", es: "spanish", fr: "french", it: "italian", pt: "portuguese",
    nl: "dutch", pl: "polish", ru: "russian", uk: "ukrainian", ja: "japanese", ko: "korean",
    zh: "chinese", ar: "arabic", hi: "hindi", tr: "turkish",
  };
  return names[language?.trim().toLowerCase() ?? ""] ?? "None";
}

function replicateText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return "";
  const record = output as Record<string, unknown>;
  for (const field of ["text", "transcription", "transcript"]) {
    if (typeof record[field] === "string") return record[field];
  }
  return "";
}

async function parseReplicatePrediction(response: Response): Promise<ReplicatePrediction> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Replicate transcription failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return await response.json() as ReplicatePrediction;
}

async function waitForReplicatePrediction(prediction: ReplicatePrediction, key: string, signal: AbortSignal): Promise<ReplicatePrediction> {
  let current = prediction;
  while (current.status === "starting" || current.status === "processing") {
    const getUrl = typeof current.urls?.get === "string" ? current.urls.get : "";
    if (!getUrl) throw new Error("Replicate transcription is still running but supplied no status URL");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, REPLICATE_POLL_MS);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    current = await parseReplicatePrediction(await fetch(getUrl, {
      headers: { authorization: `Bearer ${key}` }, signal,
    }));
  }
  return current;
}

async function replicateModelVersion(model: string, key: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(replicateModelUrl(model), {
    headers: { authorization: `Bearer ${key}` }, signal,
  });
  const metadata = await parseReplicatePrediction(response) as { latest_version?: { id?: unknown } };
  const version = metadata.latest_version?.id;
  if (typeof version !== "string" || !version) throw new Error(`Replicate model ${model} has no latest version`);
  return version;
}

async function replicateTranscribeModel(context: SttContext, key: string, model: string): Promise<SttResult> {
  const signal = sttSignal(context);
  const version = await replicateModelVersion(model, key, signal);
  const response = await fetch(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: `wait=${REPLICATE_WAIT_SECONDS}`,
    },
    body: JSON.stringify({
      version,
      input: {
        audio: replicateAudioDataUrl(context.audio),
        task: "transcribe",
        language: replicateLanguage(context.language),
      },
    }),
    signal,
  });
  const prediction = await waitForReplicatePrediction(await parseReplicatePrediction(response), key, signal);
  if (prediction.status === "failed" || prediction.status === "canceled") {
    throw new Error(`Replicate transcription ${prediction.status}${typeof prediction.error === "string" ? `: ${prediction.error}` : ""}`);
  }
  const text = replicateText(prediction.output);
  if (!text) throw new Error("Replicate transcription returned no text");
  return { text };
}

async function replicateTranscribe(context: SttContext): Promise<SttResult> {
  const key = replicateKey(context.settings);
  const primary = context.settings.sttReplicateModel || "vaibhavs10/incredibly-fast-whisper";
  const fallback = context.settings.sttReplicateFallbackModel || "openai/whisper";
  try {
    return await replicateTranscribeModel(context, key, primary);
  } catch (error) {
    // Do not turn an abort into a second request. The configured fallback is for
    // model availability/input compatibility, not cancellation recovery.
    if (context.signal?.aborted || fallback === primary) throw error;
    context.log(`Replicate STT model ${primary} failed; retrying ${fallback}`);
    return await replicateTranscribeModel(context, key, fallback);
  }
}

registerSttEngine({
  id: "replicate",
  label: "Replicate Whisper (hosted)",
  transcribe: replicateTranscribe,
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
