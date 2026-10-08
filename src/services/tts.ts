// TTS — speak one committed agent message (rebuilt from scratch 2026-10-08).
// Shape: message → speakableText → segments → per-segment COMPLETE audio file
// (mp3/wav), synthesized by a registered engine, cached on disk by content.
// The client plays the files through a plain <audio> element; no PCM
// streaming, no WebAudio scheduling (that design was the bug source).
// Engines register as DATA; the shared path never branches on an engine id.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { globalPaths } from "../core/paths.js";
import type { AgentTtsConfig } from "../core/types.js";
import { stripGaiaThinking } from "../../web/shared/gaia-think.js";
import { elevenLabsKey, replicateKey, type VoiceSettings } from "./voice.js";

// ── text ─────────────────────────────────────────────────────────────────────

/** Markdown written for the screen → text worth hearing. Deterministic. */
function speakableText(markdown: string): string {
  let text = stripGaiaThinking(String(markdown ?? ""));
  text = text.replace(/```([^\n`]*)\n[\s\S]*?(?:```|$)/g, (_m, lang: string) => {
    const name = String(lang).trim().split(/\s+/)[0];
    return name ? `\n(${name} code omitted)\n` : "\n(code omitted)\n";
  });
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, "(link)");
  text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, "");
  // Tables: separator rows vanish, cell pipes become pauses. [ \t] never \s.
  text = text.replace(/^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/gm, "");
  text = text.replace(/^[ \t]*\||\|[ \t]*$/gm, "");
  text = text.replace(/[ \t]*\|[ \t]*/g, ", ");
  text = text.replace(/^#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+•][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  text = text.replace(/(\*\*\*|\*\*|__|~~)([\s\S]*?)\1/g, "$2");
  text = text.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2");
  text = text.replace(/[→⇒]/g, " to ").replace(/[←⇐]/g, " from ").replace(/·/g, ", ");
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "");
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .join("\n")
    .trim();
}

/** First segment short → first sound fast; later ones long → few requests. */
const SEGMENT_CAPS = [160, 360];
const SEGMENT_MAX = 700;

/** Split speech text into segments on paragraph/sentence bounds. Paragraph
 * breaks inside a segment stay as `\n` (engines may turn them into pauses). */
function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let current = "";
  const cap = (): number => SEGMENT_CAPS[segments.length] ?? SEGMENT_MAX;
  const flush = (): void => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n+/)) {
    const sentences = paragraph.split(/(?<=[.!?…]["')\]]?)\s+/).filter(Boolean);
    let joiner = current ? "\n" : "";
    for (let sentence of sentences) {
      while (sentence.length > cap()) {
        // One overlong sentence: cut at the last comma/space under the cap.
        if (current) flush();
        const limit = cap();
        const slice = sentence.slice(0, limit);
        let cut = slice.lastIndexOf(", ");
        if (cut < limit * 0.4) cut = slice.lastIndexOf(" ");
        if (cut < limit * 0.4) cut = limit - 1;
        current = sentence.slice(0, cut + 1);
        flush();
        sentence = sentence.slice(cut + 1).trim();
        joiner = "";
      }
      if (!sentence) continue;
      if (current && current.length + 1 + sentence.length > cap()) {
        flush();
        joiner = "";
      }
      current += (current ? joiner || " " : "") + sentence;
      joiner = " ";
    }
  }
  flush();
  return segments;
}

// ── engines ──────────────────────────────────────────────────────────────────

export interface TtsClip {
  audio: Buffer;
  mime: string;
}

interface TtsRequest {
  text: string;
  voice: string;
  settings: VoiceSettings;
  log: (message: string) => void;
}

export interface TtsEngine {
  id: string;
  /** Known voice ids for pickers; empty = free-form (account-specific ids). */
  voices: string[];
  defaultVoice: (settings: VoiceSettings) => string;
  /** Every setting besides text+voice that changes the rendered audio. */
  fingerprint: (settings: VoiceSettings) => string;
  synthesize: (request: TtsRequest) => Promise<TtsClip>;
}

const engines = new Map<string, TtsEngine>();

export function registerTtsEngine(engine: TtsEngine): void {
  engines.set(engine.id, engine);
}
export function findTtsEngine(id: string): TtsEngine | undefined {
  return engines.get(id);
}
export function ttsEngineIds(): string[] {
  return [...engines.keys()];
}

async function failure(response: Response, what: string): Promise<Error> {
  const detail = (await response.text().catch(() => "")).slice(0, 400);
  return new Error(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

// claude — local claude-voice daemon (claude.ai "Read aloud" voices) → WAV.
async function claudeVoiceReady(baseUrl: string): Promise<"ready" | "starting" | "down"> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return "down";
    const body = (await response.json().catch(() => ({}))) as { ok?: unknown; loggedIn?: unknown; ready?: unknown };
    if (body.ok === false) return "starting";
    if (body.loggedIn === false || body.ready === false) return "starting";
    return "ready";
  } catch {
    return "down";
  }
}

async function ensureClaudeVoice(settings: VoiceSettings, log: (message: string) => void): Promise<string> {
  const baseUrl = settings.claudeVoiceUrl.replace(/\/+$/, "");
  let status = await claudeVoiceReady(baseUrl);
  if (status === "ready") return baseUrl;
  const logPath = join(globalPaths.voiceLogsDir(), "claude-voice.log");
  if (status === "down") {
    const script = settings.claudeVoiceDir ? join(settings.claudeVoiceDir, "voiced.js") : "";
    if (!script || !existsSync(script)) {
      throw new Error(`claude-voice is not running at ${baseUrl} and voice.json claudeVoiceDir has no voiced.js to start it`);
    }
    log(`tts: starting claude-voice from ${settings.claudeVoiceDir}`);
    mkdirSync(globalPaths.voiceLogsDir(), { recursive: true });
    const fd = openSync(logPath, "a");
    // Exec the script itself (shebang): in the compiled build process.execPath
    // is the gaia binary, not a JS runtime.
    spawn(script, [], { cwd: settings.claudeVoiceDir, stdio: ["ignore", fd, fd], detached: true }).unref();
  }
  const deadline = Date.now() + settings.startTimeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await claudeVoiceReady(baseUrl);
    if (status === "ready") return baseUrl;
  }
  throw new Error(`claude-voice at ${baseUrl} never became ready (${status}) — see ${logPath}`);
}

registerTtsEngine({
  id: "claude",
  voices: ["airy", "buttery", "mellow", "glassy", "rounded"],
  defaultVoice: (settings) => settings.claudeVoice,
  fingerprint: () => "",
  async synthesize({ text, voice, settings, log }) {
    const baseUrl = await ensureClaudeVoice(settings, log);
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok) throw await failure(response, "claude-voice synthesis");
        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.length <= 44) throw new Error("claude-voice returned empty audio");
        return { audio, mime: response.headers.get("content-type") || "audio/wav" };
      } catch (error) {
        last = error;
        log(`tts: claude attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  },
});

// elevenlabs — REST text-to-speech → MP3.
registerTtsEngine({
  id: "elevenlabs",
  voices: [],
  defaultVoice: (settings) => settings.elevenLabsVoice,
  fingerprint: (settings) => settings.elevenLabsModel,
  async synthesize({ text, voice, settings }) {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": elevenLabsKey(settings), "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: settings.elevenLabsModel }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    if (!response.ok) throw await failure(response, "ElevenLabs synthesis");
    return { audio: Buffer.from(await response.arrayBuffer()), mime: "audio/mpeg" };
  },
});

// minimax — MiniMax speech-02 via a Replicate prediction → MP3 URL → bytes.
interface Prediction {
  id: string;
  status: string;
  output?: string | string[] | null;
  error?: unknown;
  urls?: { get?: string };
}

registerTtsEngine({
  id: "minimax",
  voices: [],
  defaultVoice: (settings) => settings.minimaxVoice,
  fingerprint: (s) => `${s.minimaxModel}|${s.minimaxSpeed}|${s.minimaxPitch}|${s.minimaxVolume}|${s.minimaxEmotion}|${s.minimaxNormalize}|${s.minimaxParagraphPauseS}`,
  async synthesize({ text, voice, settings }) {
    const key = replicateKey(settings);
    const auth = { Authorization: `Bearer ${key}` };
    const pause = settings.minimaxParagraphPauseS;
    const input = {
      text: pause > 0 ? text.replace(/\n+/g, ` <#${pause}#> `) : text.replace(/\n+/g, " "),
      voice_id: voice,
      speed: settings.minimaxSpeed,
      pitch: settings.minimaxPitch,
      volume: settings.minimaxVolume,
      emotion: settings.minimaxEmotion,
      english_normalization: settings.minimaxNormalize,
      language_boost: "English",
    };
    const created = await fetch(`https://api.replicate.com/v1/models/${settings.minimaxModel}/predictions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", Prefer: "wait=60" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!created.ok) throw await failure(created, "MiniMax (Replicate) synthesis");
    let prediction = (await created.json()) as Prediction;
    const deadline = Date.now() + 180_000;
    while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
      if (Date.now() > deadline) throw new Error(`MiniMax prediction ${prediction.id} timed out (${prediction.status})`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const polled = await fetch(prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: auth,
        signal: AbortSignal.timeout(30_000),
      });
      if (!polled.ok) throw await failure(polled, "MiniMax (Replicate) poll");
      prediction = (await polled.json()) as Prediction;
    }
    if (prediction.status !== "succeeded") {
      throw new Error(`MiniMax synthesis ${prediction.status}: ${typeof prediction.error === "string" ? prediction.error : JSON.stringify(prediction.error)}`);
    }
    const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!url) throw new Error(`MiniMax prediction ${prediction.id} succeeded without an output URL`);
    const file = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!file.ok) throw await failure(file, "MiniMax audio download");
    return { audio: Buffer.from(await file.arrayBuffer()), mime: file.headers.get("content-type")?.startsWith("audio/") ? file.headers.get("content-type")! : "audio/mpeg" };
  },
});

// ── plan + cache ─────────────────────────────────────────────────────────────

export interface SpeechChoice {
  engine?: string;
  voice?: string;
}

export interface SpeechPlan {
  engine: TtsEngine;
  voice: string;
  segments: string[];
}

/** Engine: request override → agent.json tts.engine → voice.json ttsEngine.
 * Voice: request override → the agent's voice (only for ITS engine) → engine default. */
export function planSpeech(text: string, agentTts: AgentTtsConfig | undefined, settings: VoiceSettings, choice: SpeechChoice = {}): SpeechPlan {
  const engineId = choice.engine?.trim() || agentTts?.engine?.trim() || settings.ttsEngine;
  const engine = engines.get(engineId);
  if (!engine) throw new Error(`Unknown TTS engine "${engineId}" (available: ${ttsEngineIds().join(", ")})`);
  const agentVoice = (agentTts?.engine?.trim() || settings.ttsEngine) === engine.id ? agentTts?.voice?.trim() : undefined;
  const voice = choice.voice?.trim() || agentVoice || engine.defaultVoice(settings);
  const segments = splitSegments(speakableText(text));
  if (!segments.length) throw new Error("Nothing speakable in this message");
  return { engine, voice, segments };
}

const CACHE_MAX_FILES = 2000;
const inflight = new Map<string, Promise<TtsClip>>();
/** key → regenerate token that last re-synthesized it: one regenerate pass
 * (one token, all segments + their prefetch) renders each segment ONCE. */
const regeneratedBy = new Map<string, string>();

function segmentKey(plan: SpeechPlan, index: number, settings: VoiceSettings): string {
  return createHash("sha256")
    .update(JSON.stringify([plan.engine.id, plan.voice, plan.engine.fingerprint(settings), plan.segments[index]]))
    .digest("hex");
}

async function readCache(key: string): Promise<TtsClip | undefined> {
  const dir = globalPaths.ttsCacheDir();
  try {
    const meta = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as { mime?: string };
    const audio = await readFile(join(dir, `${key}.audio`));
    if (!audio.length || !meta.mime) return undefined;
    return { audio, mime: meta.mime };
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, clip: TtsClip, plan: SpeechPlan, index: number, settings: VoiceSettings): Promise<void> {
  const dir = globalPaths.ttsCacheDir();
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${key}.audio.${process.pid}.tmp`);
  await writeFile(tmp, clip.audio);
  await rename(tmp, join(dir, `${key}.audio`));
  await writeFile(
    join(dir, `${key}.json`),
    JSON.stringify({ mime: clip.mime, engine: plan.engine.id, voice: plan.voice, text: plan.segments[index], at: new Date().toISOString() }),
  );
  if (settings.ttsArchiveDir) {
    const ext = clip.mime.includes("mpeg") ? "mp3" : clip.mime.includes("wav") ? "wav" : "audio";
    await mkdir(settings.ttsArchiveDir, { recursive: true }).catch(() => {});
    await copyFile(join(dir, `${key}.audio`), join(settings.ttsArchiveDir, `${key}.${ext}`)).catch(() => {});
  }
}

let sweeping = false;
async function sweepCache(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const dir = globalPaths.ttsCacheDir();
    const names = (await readdir(dir)).filter((name) => name.endsWith(".audio"));
    if (names.length <= CACHE_MAX_FILES) return;
    const aged = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    aged.sort((a, b) => a.at - b.at);
    for (const { name } of aged.slice(0, aged.length - CACHE_MAX_FILES)) {
      const key = name.slice(0, -".audio".length);
      await unlink(join(dir, name)).catch(() => {});
      await unlink(join(dir, `${key}.json`)).catch(() => {});
    }
  } finally {
    sweeping = false;
  }
}

function renderSegment(plan: SpeechPlan, index: number, settings: VoiceSettings, regenerate: string, log: (message: string) => void): Promise<TtsClip> {
  const key = segmentKey(plan, index, settings);
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    if (!regenerate || regeneratedBy.get(key) === regenerate) {
      const cached = await readCache(key);
      if (cached) return cached;
    }
    const started = Date.now();
    const clip = await plan.engine.synthesize({ text: plan.segments[index], voice: plan.voice, settings, log });
    if (!clip.audio.length) throw new Error(`${plan.engine.id} returned empty audio`);
    log(`tts: ${plan.engine.id}/${plan.voice} segment ${index + 1}/${plan.segments.length} (${plan.segments[index].length} chars) → ${clip.audio.length} B in ${Date.now() - started} ms`);
    if (regenerate) {
      if (regeneratedBy.size > 500) regeneratedBy.clear();
      regeneratedBy.set(key, regenerate);
    }
    await writeCache(key, clip, plan, index, settings).catch((error) => log(`tts: cache write failed: ${String(error)}`));
    void sweepCache().catch(() => {});
    return clip;
  })();
  inflight.set(key, job);
  void job.catch(() => {}).finally(() => inflight.delete(key));
  return job;
}

/** Audio for one segment; renders the NEXT segment in the background so it is
 * ready (cached) before the client asks for it. */
export async function speakSegment(
  plan: SpeechPlan,
  index: number,
  settings: VoiceSettings,
  /** regenerate: per-playback token; non-empty = bypass the cache once. */
  opts: { regenerate?: string; log: (message: string) => void },
): Promise<TtsClip> {
  if (!Number.isInteger(index) || index < 0 || index >= plan.segments.length) {
    throw new Error(`segment ${index} out of range (0..${plan.segments.length - 1})`);
  }
  const regenerate = opts.regenerate ?? "";
  const clip = renderSegment(plan, index, settings, regenerate, opts.log);
  if (index + 1 < plan.segments.length) {
    void clip
      .then(() => renderSegment(plan, index + 1, settings, regenerate, opts.log))
      .catch((error) => opts.log(`tts: prefetch of segment ${index + 2} failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  return clip;
}
