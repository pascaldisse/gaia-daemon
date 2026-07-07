// Read-aloud: the transcript play button. Turns one committed agent message
// into speech audio, uniformly across TTS engines:
//   1. speakableText — deterministic markdown→speech formatting (tool calls
//      never reach here at all: they live in event.details, not event.text)
//   2. engine registry — engines register as DATA (id + synthesize), the
//      shared path never branches on an engine id (same law as harnesses)
//   3. kyutai engine — the bundled unmute TTS service (msgpack WebSocket)
//   4. claude engine — the claude-voice daemon (claude.ai "Read aloud" voices)
// Voice calls are a different pipeline (services/voice.ts): live and duplex.
// This module is one-shot: text in, a finished WAV out.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { globalPaths } from "../core/paths.js";
import type { AgentTtsConfig } from "../core/types.js";
import type { VoiceSettings, VoiceStackSettings } from "./voice.js";

// ---------------------------------------------------------------------------
// Speakable text. Voice calls avoid pronouncing tool calls structurally (only
// text deltas ever reach TTS) and lean on a prompt instruction for formatting.
// Read-aloud speaks messages that were WRITTEN for the screen, so the
// formatting must be stripped deterministically here.

// No length cap: the whole message is spoken, like the claude.ai desktop app.
// Streaming plays the first audio in ~1s and stops on demand, so a long message
// is never a blocking wait; the batch (local) path speaks it chunk by chunk.
export function speakableText(markdown: string): string {
  let text = String(markdown ?? "");
  // Fenced code is never worth pronouncing; note what was skipped.
  text = text.replace(/```([^\n`]*)\n[\s\S]*?(?:```|$)/g, (_match, lang) => {
    const name = String(lang).trim().split(/\s+/)[0];
    return name ? ` (${name} code omitted) ` : " (code omitted) ";
  });
  // Inline code usually names a short identifier — keep the content.
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Images speak their alt text; links speak their label; bare URLs are noise.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, "(link)");
  // Table separator rows vanish; remaining pipes become pauses. Line-anchored
  // rules use [ \t] (never \s): \s matches newlines and would merge lines.
  text = text.replace(/^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/gm, "");
  text = text.replace(/^[ \t]*\||\|[ \t]*$/gm, "");
  text = text.replace(/[ \t]*\|[ \t]*/g, ", ");
  // Headings, blockquotes, list markers (horizontal rules die with the
  // separator-row rule above).
  text = text.replace(/^#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  // Emphasis and strikethrough markers.
  text = text.replace(/(\*\*\*|\*\*|__|~~)([\s\S]*?)\1/g, "$2");
  text = text.replace(/([*_])([^*_\n]+)\1/g, "$2");
  // Emoji and pictographs are pronounced literally by TTS — drop them.
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "");
  // Collapse whitespace, keeping line breaks as sentence pauses.
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}

/** Engines synthesize in batch, so one long message = a long wait and one
 * fragile request. Playback instead runs over sentence-packed chunks of this
 * size (≈25-30 s of speech each), fetched one after the other. */
const SPEECH_CHUNK_CHARS = 400;

/** Nothing plays until chunk 0 is fully synthesized, so the first chunks ramp
 * up from small: a ~120-char opener speaks in ~3 s instead of ~11. Engines
 * generate ~2.5x faster than speech plays, so each chunk still finishes well
 * inside the previous one's playback (the client prefetches one ahead). */
const SPEECH_CHUNK_RAMP = [120, 200, 300];

/**
 * Split speech-ready text into sentence-packed chunks of at most `maxChars`
 * (the first chunks cap lower — see SPEECH_CHUNK_RAMP). Sentences never split
 * mid-way unless a single sentence exceeds the cap (then it breaks at the last
 * comma/space before it).
 */
export function splitSpeechChunks(text: string, maxChars = SPEECH_CHUNK_CHARS): string[] {
  const sentences = String(text ?? "")
    .split(/(?<=[.!?][")\]]?)\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  // Non-decreasing per chunk index, so a piece cut for one cap fits the next.
  const cap = (): number => Math.min(maxChars, SPEECH_CHUNK_RAMP[chunks.length] ?? maxChars);
  const flush = (): void => {
    if (current) chunks.push(current);
    current = "";
  };
  const append = (piece: string): void => {
    if (current && current.length + 1 + piece.length > cap()) flush();
    current = current ? `${current} ${piece}` : piece;
  };

  for (const sentence of sentences) {
    let rest = sentence;
    for (let limit = cap(); rest.length > limit; limit = cap()) {
      const slice = rest.slice(0, limit);
      let cut = slice.lastIndexOf(", ");
      if (cut < limit * 0.4) cut = slice.lastIndexOf(" ");
      if (cut < limit * 0.4) cut = limit - 1;
      append(rest.slice(0, cut + 1).trim());
      flush();
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) append(rest);
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Minimal msgpack — exactly the subset the unmute TTS websocket speaks
// (string-keyed maps out; maps/arrays/strings/numbers/bools back in). Local so
// the daemon gains no dependency for one wire format.

export function packMessage(message: Record<string, string>): Buffer {
  const keys = Object.keys(message);
  if (keys.length > 15) throw new Error("packMessage supports at most 15 keys");
  const chunks: Buffer[] = [Buffer.from([0x80 | keys.length])];
  for (const key of keys) chunks.push(packString(key), packString(message[key]));
  return Buffer.concat(chunks);
}

function packString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 32) return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes]);
  if (bytes.length < 0x100) return Buffer.concat([Buffer.from([0xd9, bytes.length]), bytes]);
  const head = Buffer.alloc(bytes.length < 0x10000 ? 3 : 5);
  if (bytes.length < 0x10000) {
    head[0] = 0xda;
    head.writeUInt16BE(bytes.length, 1);
  } else {
    head[0] = 0xdb;
    head.writeUInt32BE(bytes.length, 1);
  }
  return Buffer.concat([head, bytes]);
}

export function unpackMessage(data: Uint8Array): unknown {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const take = (bytes: number): number => {
    const at = offset;
    offset += bytes;
    return at;
  };

  const decode = (): unknown => {
    const byte = view.getUint8(take(1));
    if (byte <= 0x7f) return byte;
    if (byte >= 0xe0) return byte - 0x100;
    if ((byte & 0xf0) === 0x80) return decodeMap(byte & 0x0f);
    if ((byte & 0xf0) === 0x90) return decodeArray(byte & 0x0f);
    if ((byte & 0xe0) === 0xa0) return decodeString(byte & 0x1f);
    switch (byte) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return decodeBin(view.getUint8(take(1)));
      case 0xc5:
        return decodeBin(view.getUint16(take(2)));
      case 0xc6:
        return decodeBin(view.getUint32(take(4)));
      case 0xca:
        return view.getFloat32(take(4));
      case 0xcb:
        return view.getFloat64(take(8));
      case 0xcc:
        return view.getUint8(take(1));
      case 0xcd:
        return view.getUint16(take(2));
      case 0xce:
        return view.getUint32(take(4));
      case 0xcf:
        return Number(view.getBigUint64(take(8)));
      case 0xd0:
        return view.getInt8(take(1));
      case 0xd1:
        return view.getInt16(take(2));
      case 0xd2:
        return view.getInt32(take(4));
      case 0xd3:
        return Number(view.getBigInt64(take(8)));
      case 0xd9:
        return decodeString(view.getUint8(take(1)));
      case 0xda:
        return decodeString(view.getUint16(take(2)));
      case 0xdb:
        return decodeString(view.getUint32(take(4)));
      case 0xdc:
        return decodeArray(view.getUint16(take(2)));
      case 0xdd:
        return decodeArray(view.getUint32(take(4)));
      case 0xde:
        return decodeMap(view.getUint16(take(2)));
      case 0xdf:
        return decodeMap(view.getUint32(take(4)));
      default:
        throw new Error(`Unsupported msgpack type 0x${byte.toString(16)}`);
    }
  };
  const decodeString = (length: number): string => Buffer.from(data.subarray(offset, (offset += length))).toString("utf8");
  const decodeBin = (length: number): Uint8Array => data.subarray(offset, (offset += length));
  const decodeArray = (length: number): unknown[] => Array.from({ length }, () => decode());
  const decodeMap = (length: number): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < length; i++) {
      const key = decode();
      result[String(key)] = decode();
    }
    return result;
  };

  return decode();
}

// ---------------------------------------------------------------------------
// WAV plumbing shared by engines that return raw PCM.

export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function floatFramesToWav(frames: number[][], sampleRate: number): Buffer {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const pcm = Buffer.alloc(total * 2);
  let offset = 0;
  for (const frame of frames) {
    for (const sample of frame) {
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm.writeInt16LE(Math.round(clamped * 32767), offset);
      offset += 2;
    }
  }
  return pcmToWav(pcm, sampleRate);
}

// ---------------------------------------------------------------------------
// Engine registry. An engine is DATA: an id plus a synthesize function over
// the uniform context. The shared read-aloud path resolves engines from this
// registry only — adding an engine is one registerTtsEngine call, and no
// shared code may ever branch on a specific engine id.

export interface TtsAudio {
  audio: Buffer;
  contentType: string;
}

/** Raw-PCM stream shape for engines that synthesize the whole message in one
 * continuous pass (the desktop-app path): the format up front, then frames as
 * they are generated. Frames are s16le PCM at `sampleRate`/`channels`. */
export interface TtsStreamFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface TtsStream {
  format: TtsStreamFormat;
  frames: AsyncIterable<Buffer>;
}

/** Duplex synthesis: text is fed in OVER TIME (sentence by sentence, as the
 * agent generates its reply) into one continuous stream, and PCM frames come
 * back as they are produced — exactly how the claude.ai app drives a live turn.
 * The win over `synthesizeStream` for calls: speech for the first sentence
 * starts while the rest of the reply is still being written, and each fed piece
 * is a whole sentence, so chunk boundaries never fall mid-word. */
export interface TtsDuplexSession {
  format: TtsStreamFormat;
  /** Feed the next speech-ready piece (a whole sentence/clause). */
  push(text: string): void;
  /** No more text will be fed; the stream ends once the fed text drains. */
  end(): void;
  frames: AsyncIterable<Buffer>;
}

/** Context for duplex synthesis: like synthesis, minus the up-front `text`
 * (which arrives incrementally via `push`). */
export type TtsDuplexContext = Omit<TtsSynthesisContext, "text">;

export interface TtsSynthesisContext {
  /** Speech-ready text (already through speakableText). */
  text: string;
  /** Engine-specific voice id; undefined = the engine's default voice. */
  voice?: string;
  settings: VoiceSettings;
  /** Bring up the bundled unmute TTS service if needed → its HTTP base URL. */
  ensureTts(onStatus: (message: string) => void): Promise<{ ttsUrl: string }>;
  log(message: string): void;
  /** Abort in-flight synthesis. Read-aloud never sets it; the voice-call bridge
   * passes the call's signal so a barge-in stops generation immediately. */
  signal?: AbortSignal;
}

export interface TtsEngineSpec {
  id: string;
  /** Known voice ids, surfaced as settings hints ([] = free-form). */
  voices: string[];
  synthesize(context: TtsSynthesisContext): Promise<TtsAudio>;
  /** Optional: synthesize the whole message as ONE continuous stream, played
   * frame-by-frame as it arrives (matches the claude.ai desktop app). Declaring
   * this is a pure capability — the shared read-aloud path checks for its
   * presence, never for the engine id, and engines without it keep the batched
   * per-chunk `synthesize` path (local TTS). */
  synthesizeStream?(context: TtsSynthesisContext): Promise<TtsStream>;
  /** Optional: feed text incrementally into one continuous stream (see
   * TtsDuplexSession). The call bridge uses this when present so speech starts
   * on the first sentence instead of waiting for the whole reply; engines
   * without it fall back to buffering the turn and calling synthesizeStream.
   * Pure capability — read by presence, never by engine id. */
  synthesizeDuplex?(context: TtsDuplexContext): Promise<TtsDuplexSession>;
  /** This engine can speak a live voice CALL through gaia's protocol bridge
   * (services/voice-tts-bridge.ts turns synthesizeStream into unmute's TTS
   * websocket). Engines without it are read-aloud only; the default (kyutai)
   * call path is the native unmute TTS service, not this bridge. Pure DATA —
   * the call path reads this flag, never an engine id (same law as harnesses).
   * Requires synthesizeStream. */
  callBridge?: boolean;
}

const engines = new Map<string, TtsEngineSpec>();

export function registerTtsEngine(spec: TtsEngineSpec): void {
  engines.set(spec.id, spec);
}

export function findTtsEngine(id: string): TtsEngineSpec | undefined {
  return engines.get(id);
}

export function ttsEngineIds(): string[] {
  return [...engines.keys()];
}

/** The engine+voice one agent's messages speak with: agent tts config over the
 * workspace default engine; tts.voice over the agent's call voice. */
export function resolveTtsChoice(
  agent: { voice?: string; tts?: AgentTtsConfig } | undefined,
  settings: VoiceSettings,
): { engine: TtsEngineSpec; voice?: string } {
  const engineId = agent?.tts?.engine ?? settings.ttsEngine;
  const engine = findTtsEngine(engineId);
  if (!engine) throw new Error(`Unknown TTS engine "${engineId}" (available: ${ttsEngineIds().join(", ")})`);
  return { engine, voice: agent?.tts?.voice ?? agent?.voice };
}

// ---------------------------------------------------------------------------
// Chunk cache: derived data, content-addressed on (engine, voice, chunk text)
// so replays — and identical chunks anywhere — never re-synthesize. Best
// effort: a cache failure only costs a regeneration, never the request.

/** Newest cache entries kept by the size sweep (audio+meta pairs). */
const TTS_CACHE_MAX_ENTRIES = 500;

function ttsCacheKey(engineId: string, voice: string | undefined, text: string): string {
  return createHash("sha256").update([engineId, voice ?? "", text].join("\n")).digest("hex");
}

async function readCachedAudio(dir: string, key: string): Promise<TtsAudio | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as { contentType?: string };
    const audio = await readFile(join(dir, `${key}.audio`));
    return { audio, contentType: meta.contentType ?? "audio/wav" };
  } catch {
    return undefined;
  }
}

async function writeCachedAudio(dir: string, key: string, result: TtsAudio, format?: TtsStreamFormat): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.audio`), result.audio);
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ contentType: result.contentType, ...(format ? { format } : {}) }));
    void sweepTtsCache(dir).catch(() => {});
  } catch {
    // Cache is best-effort.
  }
}

/** Cache read for the streaming path: the whole-message PCM plus its format
 * (stored as an `.audio`/`.json` pair like every other entry, so the size
 * sweep covers it too). Undefined when there is no PCM entry for this key. */
async function readCachedPcm(dir: string, key: string): Promise<{ pcm: Buffer; format: TtsStreamFormat } | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as { format?: TtsStreamFormat };
    if (!meta.format) return undefined;
    return { pcm: await readFile(join(dir, `${key}.audio`)), format: meta.format };
  } catch {
    return undefined;
  }
}

async function sweepTtsCache(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".audio"));
  if (names.length <= TTS_CACHE_MAX_ENTRIES) return;
  const dated = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })),
  );
  dated.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of dated.slice(TTS_CACHE_MAX_ENTRIES)) {
    await unlink(join(dir, name)).catch(() => {});
    await unlink(join(dir, name.replace(/\.audio$/, ".json"))).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The shared read-aloud path (daemon calls this; server streams the result).
// One call = one CHUNK of the message: the client asks for chunk 0, learns the
// total from the result, and fetches/plays the rest back-to-back.

export interface ReadAloudRequest {
  event: { author: string; text: string };
  agent?: { voice?: string; tts?: AgentTtsConfig };
  settings: VoiceSettings;
  ensureTts: TtsSynthesisContext["ensureTts"];
  log?: (message: string) => void;
  /** Which speech chunk to synthesize (default 0). */
  chunk?: number;
  /** Cache directory override (tests); default ~/.gaia/cache/tts. */
  cacheDir?: string;
}

export interface ReadAloudResult extends TtsAudio {
  /** Total speech chunks in this message. */
  chunks: number;
  /** The chunk this audio is for. */
  chunk: number;
}

export async function readAloud(request: ReadAloudRequest): Promise<ReadAloudResult> {
  if (request.event.author === "user") throw new Error("Only agent messages can be read aloud");
  const text = speakableText(request.event.text);
  if (!text) throw new Error("Nothing to read aloud in this message");

  const chunks = splitSpeechChunks(text);
  const index = request.chunk ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= chunks.length) {
    throw new Error(`Unknown chunk ${index} (message has ${chunks.length})`);
  }

  const { engine, voice } = resolveTtsChoice(request.agent, request.settings);
  const cacheDir = request.cacheDir ?? globalPaths.ttsCacheDir();
  const key = ttsCacheKey(engine.id, voice, chunks[index]);
  const cached = await readCachedAudio(cacheDir, key);
  if (cached) return { ...cached, chunks: chunks.length, chunk: index };

  const result = await engine.synthesize({
    text: chunks[index],
    voice,
    settings: request.settings,
    ensureTts: request.ensureTts,
    log: request.log ?? (() => {}),
  });
  await writeCachedAudio(cacheDir, key, result);
  return { ...result, chunks: chunks.length, chunk: index };
}

// ---------------------------------------------------------------------------
// The streaming read-aloud path — the whole message synthesized as ONE
// continuous pass and streamed frame-by-frame, played the instant the first
// frame lands (matches the claude.ai desktop app). Used ONLY for engines that
// declare `synthesizeStream`; batch-only engines report mode "chunks" so the
// client keeps the per-chunk path. Dispatch is on the capability, never on the
// engine id (RULE #0) — and the client, in turn, dispatches on `mode`.

export type ReadAloudDelivery =
  | { mode: "chunks"; chunks: number }
  | ({ mode: "stream" } & TtsStream);

/** ~32 KB PCM frames when replaying a cached whole-message stream. */
const PCM_REPLAY_FRAME_BYTES = 32 * 1024;

async function* framesFromBuffer(pcm: Buffer): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < pcm.length; offset += PCM_REPLAY_FRAME_BYTES) {
    yield pcm.subarray(offset, offset + PCM_REPLAY_FRAME_BYTES);
  }
}

/** Pass frames through untouched while collecting them; on a CLEAN completion
 * (source exhausted, not a consumer break or error) write the whole PCM to the
 * cache so replays are instant and free. Best-effort — a cache miss only costs
 * a regeneration. */
async function* teeFramesToCache(
  frames: AsyncIterable<Buffer>,
  dir: string,
  key: string,
  format: TtsStreamFormat,
): AsyncGenerator<Buffer> {
  const collected: Buffer[] = [];
  let complete = false;
  try {
    for await (const frame of frames) {
      collected.push(Buffer.from(frame));
      yield frame;
    }
    complete = true;
  } finally {
    if (complete && collected.length) {
      await writeCachedAudio(dir, key, { audio: Buffer.concat(collected), contentType: "audio/pcm" }, format).catch(() => {});
    }
  }
}

export async function readAloudStream(request: ReadAloudRequest): Promise<ReadAloudDelivery> {
  if (request.event.author === "user") throw new Error("Only agent messages can be read aloud");
  const text = speakableText(request.event.text);
  if (!text) throw new Error("Nothing to read aloud in this message");

  const { engine, voice } = resolveTtsChoice(request.agent, request.settings);
  // Batch-only engine (local TTS): the client uses the chunked path unchanged.
  if (!engine.synthesizeStream) return { mode: "chunks", chunks: splitSpeechChunks(text).length };

  const cacheDir = request.cacheDir ?? globalPaths.ttsCacheDir();
  const key = ttsCacheKey(`${engine.id}:stream`, voice, text);
  const cached = await readCachedPcm(cacheDir, key);
  if (cached) return { mode: "stream", format: cached.format, frames: framesFromBuffer(cached.pcm) };

  const stream = await engine.synthesizeStream({
    text,
    voice,
    settings: request.settings,
    ensureTts: request.ensureTts,
    log: request.log ?? (() => {}),
  });
  return { mode: "stream", format: stream.format, frames: teeFramesToCache(stream.frames, cacheDir, key, stream.format) };
}

/** VoiceSettings → the stack subset ensureTts needs (mirrors startVoiceCall). */
export function ttsStackSettings(settings: VoiceSettings): VoiceStackSettings {
  return {
    unmuteUrl: settings.unmuteUrl,
    unmuteDir: settings.unmuteDir,
    autoStart: settings.autoStart,
    startTimeoutMs: settings.startTimeoutSec * 1000,
  };
}

// ---------------------------------------------------------------------------
// kyutai — the bundled unmute TTS service ("our" TTS). One websocket per
// request: send the text and Eos, collect 24 kHz float PCM frames until the
// server closes, wrap as WAV. The MLX adapter speaks with its configured
// voice; a per-agent voice is accepted but ignored by that server.

const KYUTAI_SAMPLE_RATE = 24_000;
const KYUTAI_IDLE_TIMEOUT_MS = 60_000;

interface WsLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

function webSocketCtor(): new (url: string) => WsLike {
  const ctor = (globalThis as Record<string, unknown>).WebSocket;
  if (typeof ctor !== "function") throw new Error("The kyutai read-aloud engine needs Node >= 22 (global WebSocket)");
  return ctor as new (url: string) => WsLike;
}

async function kyutaiSynthesize(context: TtsSynthesisContext): Promise<TtsAudio> {
  const { ttsUrl } = await context.ensureTts((message) => context.log(message));
  const Ws = webSocketCtor();
  const socket = new Ws(`${ttsUrl.replace(/^http/, "ws")}/api/tts_streaming`);
  socket.binaryType = "arraybuffer";
  const frames: number[][] = [];

  await new Promise<void>((resolve, reject) => {
    let idleTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      error ? reject(error) : resolve();
    };
    const bumpIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(new Error("kyutai TTS timed out while generating audio")), KYUTAI_IDLE_TIMEOUT_MS);
    };
    bumpIdle();
    socket.onopen = () => {
      socket.send(packMessage({ type: "Text", text: context.text }));
      socket.send(packMessage({ type: "Eos" }));
    };
    socket.onmessage = (event) => {
      bumpIdle();
      if (!(event.data instanceof ArrayBuffer)) return;
      const message = unpackMessage(new Uint8Array(event.data)) as { type?: string; pcm?: unknown; message?: unknown };
      if (message.type === "Audio" && Array.isArray(message.pcm)) frames.push(message.pcm.map(Number));
      if (message.type === "Error") finish(new Error(`kyutai TTS: ${String(message.message ?? "unknown error")}`));
    };
    socket.onerror = () => finish(new Error(`Could not reach the kyutai TTS service at ${ttsUrl}`));
    socket.onclose = () => finish(frames.length ? undefined : new Error("kyutai TTS returned no audio"));
  });

  return { audio: floatFramesToWav(frames, KYUTAI_SAMPLE_RATE), contentType: "audio/wav" };
}

registerTtsEngine({ id: "kyutai", voices: [], synthesize: kyutaiSynthesize });

// ---------------------------------------------------------------------------
// claude — the claude-voice daemon (claude.ai "Read aloud" voices through the
// user's own account). POST /synthesize returns a finished WAV. When the
// daemon is down and a checkout is configured, it is spawned like the unmute
// services — detached, logged, and never killed by GAIA (it outlives calls).

const CLAUDE_VOICES = ["airy", "buttery", "mellow", "glassy", "rounded"];
const CLAUDE_SYNTH_TIMEOUT_MS = 180_000;

async function claudeVoiceHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureClaudeVoiceDaemon(context: TtsSynthesisContext): Promise<string> {
  const baseUrl = context.settings.claudeVoiceUrl.replace(/\/+$/, "");
  if (await claudeVoiceHealthy(baseUrl)) return baseUrl;

  const dir = context.settings.claudeVoiceDir;
  if (!dir) {
    throw new Error(`claude-voice daemon is not reachable at ${baseUrl} (start it, or set voice.claudeVoiceDir in ~/.gaia/voice.json to auto-start it)`);
  }
  const script = join(dir, "voiced.js");
  if (!existsSync(script)) throw new Error(`claude-voice checkout not found at ${dir} (no voiced.js)`);

  context.log(`voice: starting claude-voice daemon from ${dir}...`);
  mkdirSync(globalPaths.voiceLogsDir(), { recursive: true });
  const log = openSync(join(globalPaths.voiceLogsDir(), "claude-voice.log"), "a");
  const child = spawn(process.execPath, [script], { cwd: dir, stdio: ["ignore", log, log], detached: true });
  child.unref();

  const deadline = Date.now() + context.settings.startTimeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await claudeVoiceHealthy(baseUrl)) return baseUrl;
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`claude-voice daemon did not become healthy at ${baseUrl} - see ${join(globalPaths.voiceLogsDir(), "claude-voice.log")}`);
}

async function claudeSynthesize(context: TtsSynthesisContext): Promise<TtsAudio> {
  const baseUrl = await ensureClaudeVoiceDaemon(context);
  const response = await fetch(`${baseUrl}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: context.text, ...(context.voice ? { voice: context.voice } : {}) }),
    signal: AbortSignal.timeout(CLAUDE_SYNTH_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new Error("claude-voice daemon has no /synthesize endpoint - update the checkout and restart the daemon");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`claude-voice synthesis failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return {
    audio: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "audio/wav",
  };
}

/** Stream the whole message as one continuous PCM pass (the desktop-app path).
 * The daemon's /stream endpoint drives one claude.ai TTS socket for the entire
 * text and forwards each PCM frame as it is generated; we surface the format
 * from its headers and yield frames straight through. No AbortSignal timeout:
 * the daemon's own idle/hard caps guarantee the stream terminates, and a client
 * disconnect cancels the reader below. */
async function claudeSynthesizeStream(context: TtsSynthesisContext): Promise<TtsStream> {
  const baseUrl = await ensureClaudeVoiceDaemon(context);
  const response = await fetch(`${baseUrl}/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: context.text, ...(context.voice ? { voice: context.voice } : {}) }),
    // A voice-call barge-in aborts here → the daemon closes the claude.ai socket
    // and stops generating into a call the user already talked over.
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (response.status === 404) {
    throw new Error("claude-voice daemon has no /stream endpoint - update the checkout and restart the daemon");
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`claude-voice stream failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const format: TtsStreamFormat = {
    sampleRate: Number(response.headers.get("x-tts-rate")) || 16_000,
    channels: Number(response.headers.get("x-tts-channels")) || 1,
    bitsPerSample: Number(response.headers.get("x-tts-bits")) || 16,
  };
  return { format, frames: readableToFrames(response.body) };
}

async function* readableToFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length) yield Buffer.from(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader already closed.
    }
  }
}

/** Feed text sentence-by-sentence into ONE claude.ai TTS socket (the daemon's
 * /stream-in endpoint) and stream PCM back as it is generated. The request body
 * is NDJSON — one {"text":...} line per fed piece, a final {"end":true} — sent
 * with a streaming body (duplex) so pieces reach the daemon the instant push()
 * is called. This is the low-latency call path: sentence 1 is spoken while the
 * agent is still writing the rest. */
async function claudeSynthesizeDuplex(context: TtsDuplexContext): Promise<TtsDuplexSession> {
  const baseUrl = await ensureClaudeVoiceDaemon({ ...context, text: "" });
  const encoder = new TextEncoder();
  // Push-driven queue → an ASYNC-GENERATOR request body. (Node's fetch streams a
  // generator body reliably; a start()-enqueued ReadableStream is NOT sent until
  // it closes, which would deadlock a duplex exchange.) `null` = end sentinel.
  const queue: Array<Uint8Array | null> = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const nextChunk = (): Promise<void> => new Promise((resolve) => { wake = resolve; });
  async function* requestBody(): AsyncGenerator<Uint8Array> {
    // Prime: an immediate first chunk flushes the request headers so the daemon
    // answers (and this fetch resolves) before the first real sentence lands.
    // The daemon skips blank NDJSON lines.
    yield encoder.encode("\n");
    for (;;) {
      while (queue.length) {
        const chunk = queue.shift();
        if (chunk === null) return;
        yield chunk as Uint8Array;
      }
      await nextChunk();
    }
  }
  const query = context.voice ? `?voice=${encodeURIComponent(context.voice)}` : "";
  const response = await fetch(`${baseUrl}/stream-in${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: requestBody(),
    // Send text as it is produced while reading PCM concurrently.
    duplex: "half",
    // A barge-in aborts here → the daemon closes the claude.ai socket.
    ...(context.signal ? { signal: context.signal } : {}),
  } as RequestInit & { duplex: "half" });
  if (response.status === 404) {
    throw new Error("claude-voice daemon has no /stream-in endpoint - update the checkout and restart the daemon");
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`claude-voice stream-in failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const format: TtsStreamFormat = {
    sampleRate: Number(response.headers.get("x-tts-rate")) || 16_000,
    channels: Number(response.headers.get("x-tts-channels")) || 1,
    bitsPerSample: Number(response.headers.get("x-tts-bits")) || 16,
  };
  return {
    format,
    push(text: string): void {
      const speech = text.trim();
      if (closed || !speech) return;
      queue.push(encoder.encode(`${JSON.stringify({ text: speech })}\n`));
      wake?.();
      wake = undefined;
    },
    end(): void {
      if (closed) return;
      closed = true;
      queue.push(encoder.encode(`${JSON.stringify({ end: true })}\n`));
      queue.push(null);
      wake?.();
      wake = undefined;
    },
    frames: readableToFrames(response.body),
  };
}

registerTtsEngine({
  id: "claude",
  voices: CLAUDE_VOICES,
  synthesize: claudeSynthesize,
  synthesizeStream: claudeSynthesizeStream,
  // Feed sentences into one live socket → lowest-latency, smoothest call audio.
  synthesizeDuplex: claudeSynthesizeDuplex,
  // Streams whole-message PCM → can drive a live call through the bridge.
  callBridge: true,
});

// ---------------------------------------------------------------------------
// elevenlabs — the ElevenLabs cloud TTS API (a hosted engine, like claude-voice
// but a plain REST API, no local daemon). We request raw s16le PCM at 24 kHz so
// the batch path wraps it as WAV and the stream path yields frames straight
// through — identical to the claude engine's shape, so read-aloud AND live
// calls (callBridge) work uniformly. Expressiveness comes from the model
// (eleven_v3 renders inline [moans]/[breathy]/[laughs] audio tags) plus the
// persona's own text; the engine passes text through untouched.

const ELEVENLABS_BASE = "https://api.elevenlabs.io";
const ELEVENLABS_SAMPLE_RATE = 24_000;
const ELEVENLABS_SYNTH_TIMEOUT_MS = 180_000;

function elevenLabsKey(settings: VoiceSettings): string {
  const key = settings.elevenLabsApiKey?.trim() || process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ElevenLabs API key not set (voice.json elevenLabsApiKey or ELEVENLABS_API_KEY env)");
  return key;
}

/** POST body + URL shared by the batch and streaming endpoints. `stream` picks
 * the `/stream` variant (frames as generated) over the one-shot endpoint. */
async function elevenLabsFetch(context: TtsSynthesisContext, stream: boolean): Promise<Response> {
  const key = elevenLabsKey(context.settings);
  const voiceId = context.voice || context.settings.elevenLabsVoice;
  const model = context.settings.elevenLabsModel;
  const path = `/v1/text-to-speech/${encodeURIComponent(voiceId)}${stream ? "/stream" : ""}?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`;
  const response = await fetch(`${ELEVENLABS_BASE}${path}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: context.text, model_id: model }),
    // Read-aloud never aborts; a voice-call barge-in passes the call's signal.
    ...(context.signal ? { signal: context.signal } : stream ? {} : { signal: AbortSignal.timeout(ELEVENLABS_SYNTH_TIMEOUT_MS) }),
  });
  if (!response.ok || (stream && !response.body)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs ${stream ? "stream" : "synthesis"} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

async function elevenLabsSynthesize(context: TtsSynthesisContext): Promise<TtsAudio> {
  const response = await elevenLabsFetch(context, false);
  const pcm = Buffer.from(await response.arrayBuffer());
  return { audio: pcmToWav(pcm, ELEVENLABS_SAMPLE_RATE), contentType: "audio/wav" };
}

async function elevenLabsSynthesizeStream(context: TtsSynthesisContext): Promise<TtsStream> {
  const response = await elevenLabsFetch(context, true);
  return {
    format: { sampleRate: ELEVENLABS_SAMPLE_RATE, channels: 1, bitsPerSample: 16 },
    frames: readableToFrames(response.body as ReadableStream<Uint8Array>),
  };
}

registerTtsEngine({
  id: "elevenlabs",
  // Voices are account-specific voice ids (this key can't list them); free-form.
  voices: [],
  synthesize: elevenLabsSynthesize,
  synthesizeStream: elevenLabsSynthesizeStream,
  // Streams whole-message PCM → can drive a live call through the bridge.
  callBridge: true,
});
