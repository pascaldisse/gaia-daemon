// Voice-call STT bridge: presents Replicate's one-shot transcription as
// unmute's streaming `/api/asr-streaming` msgpack WebSocket protocol. The
// socket and frame handling intentionally mirror voice-tts-bridge.ts; only
// the audio direction differs. The backend emits one Step per incoming audio
// block, where prs[2] is its pause probability.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { pcmToWav, unpackMessage } from "./read-aloud.js";
import { transcribe, type TranscribeRequest } from "./transcribe.js";
import { packMsg } from "./voice-tts-bridge.js";
import type { VoiceSettings } from "./voice.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const STT_SAMPLE_RATE = 24_000;
export const STT_SILENCE_MS = 600;
export const STT_ENERGY_THRESHOLD = 0.01;

/** Convert unmute's f32 PCM to the WAV input accepted by the shared STT path. */
export function float32ToWav(samples: Float32Array, sampleRate = STT_SAMPLE_RATE): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return pcmToWav(pcm, sampleRate);
}

/** Energy VAD. It only reports a boundary after speech followed by 600 ms quiet. */
export class EnergyVad {
  private speaking = false;
  private silentSamples = 0;

  constructor(
    private readonly threshold = STT_ENERGY_THRESHOLD,
    private readonly silenceSamplesNeeded = (STT_SAMPLE_RATE * STT_SILENCE_MS) / 1_000,
  ) {}

  push(pcm: Float32Array): { speech: boolean; boundary: boolean } {
    let energy = 0;
    for (const sample of pcm) energy += sample * sample;
    const speech = pcm.length > 0 && Math.sqrt(energy / pcm.length) >= this.threshold;
    if (speech) {
      this.speaking = true;
      this.silentSamples = 0;
      return { speech: true, boundary: false };
    }
    if (!this.speaking) return { speech: false, boundary: false };
    this.silentSamples += pcm.length;
    if (this.silentSamples < this.silenceSamplesNeeded) return { speech: false, boundary: false };
    this.reset();
    return { speech: false, boundary: true };
  }

  reset(): void {
    this.speaking = false;
    this.silentSamples = 0;
  }
}

export interface SttBridgeDeps {
  /** Defaults to the shared registry path, forced to its Replicate engine. */
  transcribe?: (request: TranscribeRequest) => ReturnType<typeof transcribe>;
  log(message: string): void;
}

export class SttCallBridge {
  private server: Server | undefined;
  private readonly sessions = new Set<SttSession>();
  private port = 0;

  constructor(private readonly deps: SttBridgeDeps) {}

  /** Bind an ephemeral endpoint to feed unmute as KYUTAI_STT_URL. */
  async start(settings: VoiceSettings): Promise<{ wsUrl: string; httpUrl: string }> {
    const server = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/api/build_info" || path === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "gaia-stt-bridge", backend: "replicate", status: "ok", sample_rate: STT_SAMPLE_RATE }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on("upgrade", (request, socket) => {
      if (!(request.url ?? "").split("?")[0].endsWith("/api/asr-streaming")) {
        socket.destroy();
        return;
      }
      this.accept(request, socket as Socket, settings);
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
    if (!this.port) throw new Error("STT bridge could not bind a port");
    return { wsUrl: `ws://127.0.0.1:${this.port}`, httpUrl: `http://127.0.0.1:${this.port}` };
  }

  /** Hang-up / teardown: abort live Replicate requests and close the listener. */
  stop(): void {
    for (const session of this.sessions) session.close();
    this.sessions.clear();
    this.server?.close();
    this.server = undefined;
  }

  private accept(request: IncomingMessage, socket: Socket, settings: VoiceSettings): void {
    console.log("STT ACCEPT", request.url);
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const session = new SttSession(socket, settings, this.deps, () => this.sessions.delete(session));
    this.sessions.add(session);
    session.begin();
  }
}

class SttSession {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  private readonly aborter = new AbortController();
  private readonly vad = new EnergyVad();
  private samples: number[] = [];
  private utteranceStartSamples = 0;
  private receivedSamples = 0;
  private stepIndex = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: Socket,
    private readonly settings: VoiceSettings,
    private readonly deps: SttBridgeDeps,
    private readonly onClosed: () => void,
  ) {}

  begin(): void {
    console.log("STT BEGIN");
    this.socket.on("data", (chunk: Buffer) => { console.log("STT DATA", chunk.length); this.onData(chunk); });
    this.socket.on("close", () => this.close());
    this.socket.on("error", () => this.close());
    this.send(0x2, { type: "Ready" });
    console.log("STT READY SENT");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.aborter.abort();
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.onClosed();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
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
    let mask: Buffer | undefined;
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
    if (opcode === 0x8) return this.close();
    if (opcode === 0x9) return this.sendRaw(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x0) this.fragments.push(payload);
    else this.fragments = [payload];
    if (!fin) return;
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.onMessage(message);
  }

  private onMessage(data: Buffer): void {
    let message: { type?: unknown; pcm?: unknown; id?: unknown };
    try {
      message = unpackMessage(new Uint8Array(data)) as { type?: unknown; pcm?: unknown; id?: unknown };
    } catch (error) {
      console.log("STT DECODE ERROR", error);
      return;
    }
    console.log("STT IN", message.type, Array.isArray(message.pcm) ? message.pcm.length : "");
    if (message.type === "Audio" && Array.isArray(message.pcm)) {
      const pcm = Float32Array.from(message.pcm.map((value) => typeof value === "number" && Number.isFinite(value) ? value : 0));
      this.onAudio(pcm);
    } else if (message.type === "Marker" && typeof message.id === "number") {
      this.flush();
      // Marker is a queue barrier: acknowledgement proves every preceding
      // utterance was transcribed (or reported as an Error) first.
      this.pending = this.pending.then(() => { if (!this.closed) this.send(0x2, { type: "Marker", id: message.id }); });
    }
  }

  private onAudio(pcm: Float32Array): void {
    const wasIdle = this.samples.length === 0;
    const state = this.vad.push(pcm);
    this.receivedSamples += pcm.length;
    // unmute reads prs[2] as P(pause). A 0/1 energy VAD signal is deliberately
    // simple: its EMA smooths it, and emits a turn-detection pause on quiet.
    this.send(0x2, { type: "Step", step_idx: this.stepIndex++, prs: [0, 0, state.speech ? 0 : 1] });
    if (state.speech && wasIdle) this.utteranceStartSamples = this.receivedSamples - pcm.length;
    if (this.samples.length || state.speech) this.samples.push(...pcm);
    if (state.boundary) this.flush();
  }

  /** Flush an active utterance; marker and silence boundaries share this path. */
  private flush(): void {
    if (!this.samples.length) return;
    const samples = Float32Array.from(this.samples);
    const startTime = this.utteranceStartSamples / STT_SAMPLE_RATE;
    const stopTime = this.receivedSamples / STT_SAMPLE_RATE;
    this.samples = [];
    this.vad.reset();
    this.pending = this.pending.then(() => this.transcribeUtterance(samples, startTime, stopTime));
  }

  private async transcribeUtterance(samples: Float32Array, startTime: number, stopTime: number): Promise<void> {
    try {
      const run = this.deps.transcribe ?? transcribe;
      const result = await run({
        audio: { data: float32ToWav(samples), contentType: "audio/wav", filename: "voice-call.wav" },
        settings: this.settings,
        engineId: "replicate",
        log: this.deps.log,
        signal: this.aborter.signal,
      });
      if (this.closed) return;
      const words = result.text.trim().split(/\s+/).filter(Boolean);
      const span = Math.max((stopTime - startTime) / Math.max(words.length, 1), 0.001);
      for (let i = 0; i < words.length; i++) {
        this.send(0x2, { type: "Word", text: `${words[i]}${i + 1 < words.length ? " " : ""}`, start_time: startTime + i * span });
      }
      this.send(0x2, { type: "EndWord", stop_time: stopTime });
    } catch (error) {
      if (!this.closed && !this.aborter.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log(`voice-stt-bridge: transcription failed: ${message}`);
        this.send(0x2, { type: "Error", message });
      }
    }
  }

  private send(opcode: number, message: unknown): void {
    this.sendRaw(opcode, packMsg(message));
  }

  private sendRaw(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 0x10000) {
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
    try { this.socket.write(len ? Buffer.concat([header, payload]) : header); } catch { /* close handles cleanup */ }
  }
}
