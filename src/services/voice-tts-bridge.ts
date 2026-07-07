// Voice-call TTS bridge: makes a read-aloud TTS engine (e.g. claude-voice) look
// like a native unmute TTS server, so a LIVE CALL can speak with it — not just
// the transcript ▶ button.
//
// unmute's backend dials its TTS over a msgpack WebSocket at
// `/api/tts_streaming`: it sends `{type:"Text", text}` tokens as the LLM streams
// and `{type:"Eos"}` at the end, and expects `{type:"Ready"}` up front then
// `{type:"Audio", pcm:[f32]}` frames at 24 kHz back (see unmute's
// tts_mlx_adapter.py + tts/text_to_speech.py). This module stands up exactly
// that server on an ephemeral port and, per connection, drives the engine,
// resamples whatever rate it emits to 24 kHz, and forwards the audio. Barge-in =
// the backend closes the socket → we abort the in-flight generation.
//
// Two engine paths, chosen by capability (never by id):
//   • `synthesizeDuplex` present → feed each whole sentence in as the reply is
//     written; speech for sentence 1 starts while the rest generates (lowest
//     latency, the claude-voice call path).
//   • else `synthesizeStream` → buffer the whole reply and synthesize it as one
//     stream on Eos (still one socket per turn, but waits for the full reply).
//
// RULE #0 spirit: the bridge is engine-agnostic. It drives ANY TtsEngineSpec
// that declares `callBridge`; it never learns which engine it is. The default
// (kyutai) call path is unmute's own TTS service and never touches this file.
//
// The WebSocket framing + msgpack encoder are hand-rolled for the same reason
// read-aloud.ts hand-rolls its msgpack decoder: the daemon gains no dependency
// for one small wire format. Incoming frames are decoded with read-aloud's
// `unpackMessage`.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { TtsDuplexSession, TtsEngineSpec, TtsStreamFormat, TtsSynthesisContext } from "./read-aloud.js";
import { speakableText, unpackMessage } from "./read-aloud.js";
import type { VoiceSettings } from "./voice.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TARGET_RATE = 24_000;
/** unmute's own frame is 1920 samples (80 ms @ 24 kHz); we match it. */
const FRAME_SAMPLES = 1_920;

// ---------------------------------------------------------------------------
// Minimal msgpack ENCODER — just the shapes this bridge sends: string-keyed
// maps, strings, and float arrays (the pcm). Numbers are always emitted as
// float32, which is all the pcm needs (unmute reads them into a float32 array).

export function packMsg(value: unknown): Buffer {
  const parts: Buffer[] = [];
  encode(value, parts);
  return Buffer.concat(parts);
}

function encode(value: unknown, out: Buffer[]): void {
  if (value === null || value === undefined) {
    out.push(Buffer.from([0xc0]));
  } else if (typeof value === "boolean") {
    out.push(Buffer.from([value ? 0xc3 : 0xc2]));
  } else if (typeof value === "number") {
    const buf = Buffer.allocUnsafe(5);
    buf[0] = 0xca;
    buf.writeFloatBE(value, 1);
    out.push(buf);
  } else if (typeof value === "string") {
    encodeString(value, out);
  } else if (Array.isArray(value)) {
    encodeArrayHeader(value.length, out);
    for (const item of value) encode(item, out);
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    encodeMapHeader(entries.length, out);
    for (const [key, item] of entries) {
      encodeString(key, out);
      encode(item, out);
    }
  } else {
    throw new Error(`packMsg: unsupported value ${typeof value}`);
  }
}

function encodeString(value: string, out: Buffer[]): void {
  const bytes = Buffer.from(value, "utf8");
  const len = bytes.length;
  if (len < 32) out.push(Buffer.from([0xa0 | len]));
  else if (len < 0x100) out.push(Buffer.from([0xd9, len]));
  else if (len < 0x10000) {
    const head = Buffer.allocUnsafe(3);
    head[0] = 0xda;
    head.writeUInt16BE(len, 1);
    out.push(head);
  } else {
    const head = Buffer.allocUnsafe(5);
    head[0] = 0xdb;
    head.writeUInt32BE(len, 1);
    out.push(head);
  }
  out.push(bytes);
}

function encodeArrayHeader(len: number, out: Buffer[]): void {
  if (len < 16) out.push(Buffer.from([0x90 | len]));
  else if (len < 0x10000) {
    const head = Buffer.allocUnsafe(3);
    head[0] = 0xdc;
    head.writeUInt16BE(len, 1);
    out.push(head);
  } else {
    const head = Buffer.allocUnsafe(5);
    head[0] = 0xdd;
    head.writeUInt32BE(len, 1);
    out.push(head);
  }
}

function encodeMapHeader(len: number, out: Buffer[]): void {
  if (len < 16) out.push(Buffer.from([0x80 | len]));
  else {
    const head = Buffer.allocUnsafe(3);
    head[0] = 0xde;
    head.writeUInt16BE(len, 1);
    out.push(head);
  }
}

// ---------------------------------------------------------------------------
// Streaming linear resampler: engine rate → 24 kHz, carrying one sample of
// history across frames so there is no discontinuity at frame boundaries. Works
// for both up- and down-sampling; a no-op when the rates already match.

export class Resampler {
  private readonly step: number;
  private prev = 0;
  private hasPrev = false;
  private next = 0; // position of the next output sample, in input samples

  constructor(inRate: number, outRate: number) {
    this.step = inRate > 0 ? inRate / outRate : 1;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1 || input.length === 0) {
      if (input.length) {
        this.prev = input[input.length - 1];
        this.hasPrev = true;
      }
      return this.step === 1 ? input : new Float32Array(0);
    }
    const n = input.length;
    if (!this.hasPrev) {
      this.prev = input[0];
      this.hasPrev = true;
    }
    const sampleAt = (index: number): number => (index < 0 ? this.prev : input[index]);
    const out: number[] = [];
    let pos = this.next;
    while (pos < n - 1) {
      const base = Math.floor(pos);
      const frac = pos - base;
      out.push(sampleAt(base) * (1 - frac) + sampleAt(base + 1) * frac);
      pos += this.step;
    }
    this.next = pos - n; // carry to the next buffer (prev becomes input[n-1])
    this.prev = input[n - 1];
    return Float32Array.from(out);
  }
}

// ---------------------------------------------------------------------------
// s16le byte stream → float samples, carrying a straggling odd byte across
// frame boundaries (the engine yields arbitrary byte-sized chunks).

class PcmS16Decoder {
  private leftover: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): Float32Array {
    const bytes = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const usable = bytes.length - (bytes.length % 2);
    this.leftover = bytes.subarray(usable);
    const samples = new Float32Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    return samples;
  }
}

// ---------------------------------------------------------------------------
// Bridge server.

export interface TtsBridgeDeps {
  /** Bring up the bundled unmute TTS service if an engine needs it (kyutai);
   *  claude-voice never calls this. */
  ensureTts: TtsSynthesisContext["ensureTts"];
  log(message: string): void;
}

export class TtsCallBridge {
  private server: Server | undefined;
  private readonly sessions = new Set<TtsSession>();
  private port = 0;

  constructor(private readonly deps: TtsBridgeDeps) {}

  /** Bind an ephemeral port and serve unmute's TTS protocol backed by `engine`.
   *  Returns the ws:// URL to feed unmute as KYUTAI_TTS_URL. */
  async start(engine: TtsEngineSpec, voice: string | undefined, settings: VoiceSettings): Promise<{ wsUrl: string; httpUrl: string }> {
    if (!engine.synthesizeStream && !engine.synthesizeDuplex) {
      throw new Error(`TTS engine "${engine.id}" cannot drive a voice call (no streaming synthesis)`);
    }
    const server = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/api/build_info" || path === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "gaia-tts-bridge", backend: engine.id, status: "ok", sample_rate: TARGET_RATE }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on("upgrade", (request, socket) => {
      const path = (request.url ?? "").split("?")[0];
      if (!path.endsWith("/api/tts_streaming")) {
        socket.destroy();
        return;
      }
      this.accept(request, socket as Socket, engine, voice, settings);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    if (!this.port) throw new Error("TTS bridge could not bind a port");
    return { wsUrl: `ws://127.0.0.1:${this.port}`, httpUrl: `http://127.0.0.1:${this.port}` };
  }

  /** Hang-up / teardown: abort every live session and close the listener. */
  stop(): void {
    for (const session of this.sessions) session.close();
    this.sessions.clear();
    this.server?.close();
    this.server = undefined;
  }

  private accept(request: IncomingMessage, socket: Socket, engine: TtsEngineSpec, voice: string | undefined, settings: VoiceSettings): void {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // A per-connection voice override from the query wins over the baked-in one.
    const urlVoice = new URLSearchParams((request.url ?? "").split("?")[1] ?? "").get("voice") ?? undefined;
    const session = new TtsSession(socket, engine, urlVoice || voice, settings, this.deps, () => this.sessions.delete(session));
    this.sessions.add(session);
    session.begin();
  }
}

// ---------------------------------------------------------------------------
// One TTS websocket connection = one assistant turn's worth of speech.

class TtsSession {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOpcode = 0;
  private textBuffer = "";
  private synthesizing = false;
  private closed = false;
  private readonly aborter = new AbortController();
  // Duplex (incremental) path: `textTail` holds text not yet flushed as a whole
  // sentence; `duplexReady` is the live session (started on the first token);
  // `feedChain` serializes push/end so sentences reach the engine in order.
  private textTail = "";
  private duplexReady: Promise<TtsDuplexSession> | undefined;
  private feedChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: Socket,
    private readonly engine: TtsEngineSpec,
    private readonly voice: string | undefined,
    private readonly settings: VoiceSettings,
    private readonly deps: TtsBridgeDeps,
    private readonly onClosed: () => void,
  ) {}

  begin(): void {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("close", () => this.close());
    this.socket.on("error", () => this.close());
    this.send(0x2, packMsg({ type: "Ready" }));
  }

  /** Barge-in / hang-up: stop generating and drop the socket. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.aborter.abort();
    try {
      this.socket.destroy();
    } catch {
      // Already gone.
    }
    this.onClosed();
  }

  // --- incoming WebSocket frames ------------------------------------------

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame.opcode, frame.payload, frame.fin);
    }
  }

  private readFrame(): { opcode: number; payload: Buffer; fin: boolean } | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (mask) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    }
    this.buffer = buf.subarray(offset + len);
    return { opcode, payload, fin };
  }

  private handleFrame(opcode: number, payload: Buffer, fin: boolean): void {
    if (opcode === 0x8) {
      // Close.
      this.close();
      return;
    }
    if (opcode === 0x9) {
      // Ping → pong (echo).
      this.send(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // Pong.

    // Data frame (0x1 text / 0x2 binary) or continuation (0x0).
    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragOpcode = opcode;
    }
    if (!fin) return;
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.onMessage(message);
  }

  private onMessage(data: Buffer): void {
    let message: { type?: unknown; text?: unknown };
    try {
      message = unpackMessage(new Uint8Array(data)) as { type?: unknown; text?: unknown };
    } catch {
      return; // Not something we speak; ignore.
    }
    const type = String(message.type ?? "");
    if (type === "Text") {
      const text = String(message.text ?? "");
      // Duplex engines (claude) get each whole sentence the instant it lands, so
      // speech starts while the reply is still being written. Others buffer the
      // whole reply and synthesize once on Eos.
      if (this.engine.synthesizeDuplex) this.feedText(text);
      else this.textBuffer += text;
    } else if (type === "Eos") {
      if (this.engine.synthesizeDuplex) this.endText();
      else void this.synthesizeTurn();
    }
    // "Voice" and anything else: ignored — the voice is fixed for the call.
  }

  // --- synthesis pipeline --------------------------------------------------

  // DUPLEX PATH (claude): feed each whole sentence into one continuous stream as
  // the reply is written, so sentence 1 is spoken while the rest generates.
  // Sentences reach the engine in order via `feedChain`; the frame pump starts
  // with the stream and closes the turn when the audio drains.

  /** Buffer incoming text and flush every COMPLETE sentence to the engine. A
   * sentence is only flushed once its terminating whitespace has arrived, so a
   * mid-token "3.14" or "e.g." is never split — which also keeps the engine's
   * chunk boundaries on real sentence ends (no trailing "." spoken as "dot"). */
  private feedText(raw: string): void {
    this.textTail += raw;
    const boundary = /[.!?…]+["')\]]*\s+|\n+/g;
    let flushedTo = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.textTail))) {
      const end = match.index + match[0].length;
      this.queuePush(this.textTail.slice(flushedTo, end));
      flushedTo = end;
    }
    if (flushedTo) this.textTail = this.textTail.slice(flushedTo);
  }

  /** Eos: flush the final partial sentence and close the input; the pump ends
   * the turn once the last audio drains. */
  private endText(): void {
    const tail = this.textTail.trim();
    this.textTail = "";
    if (tail) this.queuePush(tail);
    this.feedChain = this.feedChain
      .then(async () => {
        if (this.duplexReady) {
          const session = await this.duplexReady;
          if (!this.closed) session.end();
        } else if (!this.closed) {
          // Empty reply — nothing was ever fed; just end the turn.
          this.finish();
        }
      })
      .catch((error) => this.onDuplexError(error));
  }

  private queuePush(sentence: string): void {
    const speech = speakableText(sentence);
    if (!speech) return;
    this.feedChain = this.feedChain
      .then(async () => {
        const session = await this.ensureDuplex();
        if (!this.closed) session.push(speech);
      })
      .catch((error) => this.onDuplexError(error));
  }

  private ensureDuplex(): Promise<TtsDuplexSession> {
    if (!this.duplexReady) {
      this.duplexReady = this.engine.synthesizeDuplex!({
        voice: this.voice,
        settings: this.settings,
        ensureTts: this.deps.ensureTts,
        log: this.deps.log,
        signal: this.aborter.signal,
      }).then((session) => {
        // Start pumping audio out the moment the stream exists.
        void this.pumpFrames(session.format, session.frames).then(() => {
          if (!this.closed) this.finish();
        });
        return session;
      });
    }
    return this.duplexReady;
  }

  private onDuplexError(error: unknown): void {
    if (this.closed) return;
    this.deps.log(`voice-tts-bridge: duplex synthesis failed: ${error instanceof Error ? error.message : String(error)}`);
    this.finish();
  }

  // FALLBACK PATH (engines with only synthesizeStream): buffer the whole reply
  // and synthesize it as ONE stream on Eos — still one socket per turn, but the
  // audio can't start until the reply is fully written.
  private async synthesizeTurn(): Promise<void> {
    if (this.synthesizing) return;
    this.synthesizing = true;
    const clean = speakableText(this.textBuffer);
    if (clean) {
      try {
        const stream = await this.engine.synthesizeStream!({
          text: clean,
          voice: this.voice,
          settings: this.settings,
          ensureTts: this.deps.ensureTts,
          log: this.deps.log,
          signal: this.aborter.signal,
        });
        await this.pumpFrames(stream.format, stream.frames);
      } catch (error) {
        if (!this.closed) this.deps.log(`voice-tts-bridge: synthesis failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Turn finished cleanly: close so unmute's client sees the end.
    if (!this.closed) this.finish();
  }

  /** Resample PCM frames to unmute's 24 kHz and forward them as 80 ms Audio
   * blocks. Shared by the duplex and one-shot paths. */
  private async pumpFrames(format: TtsStreamFormat, frames: AsyncIterable<Buffer>): Promise<void> {
    const resampler = new Resampler(format.sampleRate || TARGET_RATE, TARGET_RATE);
    const decoder = new PcmS16Decoder();
    const pending: number[] = [];
    const flush = (final: boolean): void => {
      while (pending.length >= FRAME_SAMPLES) {
        this.send(0x2, packMsg({ type: "Audio", pcm: pending.splice(0, FRAME_SAMPLES) }));
      }
      if (final && pending.length) {
        this.send(0x2, packMsg({ type: "Audio", pcm: pending.splice(0, pending.length) }));
      }
    };
    try {
      for await (const raw of frames) {
        if (this.closed) break;
        const resampled = resampler.process(decoder.push(raw));
        for (const sample of resampled) pending.push(sample);
        flush(false);
      }
      if (!this.closed) flush(true);
    } catch (error) {
      // Aborted (barge-in) or mid-stream failure: stop; the socket close (or the
      // next turn) handles the rest.
      if (!this.closed) this.deps.log(`voice-tts-bridge: stream ended early: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.send(0x8, Buffer.alloc(0)); // Close frame.
    try {
      this.socket.end();
    } catch {
      // Already gone.
    }
    this.onClosed();
  }

  // --- outgoing WebSocket frames ------------------------------------------

  private send(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 0x10000) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(len ? Buffer.concat([header, payload]) : header);
    } catch {
      // Socket died mid-write; close() will clean up.
    }
  }
}
