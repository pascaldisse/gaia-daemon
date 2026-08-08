import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  TtsCallBridge,
  Resampler,
  packMsg,
  type TtsBridgeDeps,
} from "../src/services/voice-tts-bridge.js";
import {
  findTtsEngine,
  registerTtsEngine,
  unpackMessage,
  type TtsDuplexSession,
  type TtsEngineSpec,
  type TtsStream,
  type TtsSynthesisContext,
} from "../src/services/read-aloud.js";
import { VOICE_SETTINGS_DEFAULTS } from "../src/services/voice.js";

const deps: TtsBridgeDeps = { ensureTts: async () => ({ ttsUrl: "" }), log: () => {} };

// --- msgpack encoder --------------------------------------------------------

test("packMsg round-trips string maps and float pcm through unpackMessage", () => {
  const ready = unpackMessage(new Uint8Array(packMsg({ type: "Ready" }))) as { type: string };
  assert.equal(ready.type, "Ready");

  const audio = unpackMessage(new Uint8Array(packMsg({ type: "Audio", pcm: [0, 0.5, -0.5, 0.25, -0.75] }))) as {
    type: string;
    pcm: number[];
  };
  assert.equal(audio.type, "Audio");
  assert.deepEqual(audio.pcm, [0, 0.5, -0.5, 0.25, -0.75]); // all exact in float32
});

// --- resampler --------------------------------------------------------------

test("Resampler is an identity when the rates match", () => {
  const input = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  assert.equal(new Resampler(24_000, 24_000).process(input), input);
});

test("Resampler upsamples 16k→24k by ~1.5x, continuously across frames", () => {
  const rs = new Resampler(16_000, 24_000);
  const ramp = Float32Array.from({ length: 32 }, (_v, i) => i);
  const a = rs.process(ramp);
  // First output sample sits on the first input sample.
  assert.equal(a[0], 0);
  // ~1.5x as many output samples as input (allow ±1 for the tail boundary).
  assert.ok(Math.abs(a.length - 48) <= 1, `got ${a.length}`);
  // Monotonic (a ramp resampled linearly stays non-decreasing).
  for (let i = 1; i < a.length; i++) assert.ok(a[i] >= a[i - 1], `not monotonic at ${i}`);
  // A second frame continues the ramp without a discontinuity at the boundary.
  const ramp2 = Float32Array.from({ length: 32 }, (_v, i) => 32 + i);
  const b = rs.process(ramp2);
  assert.ok(b[0] > a[a.length - 1], "second frame continues upward across the boundary");
});

// --- sentence chunking ------------------------------------------------------

// --- end-to-end: a fake streaming engine spoken over the WS protocol --------

/** A callBridge engine that emits `totalBytes` of deterministic s16le PCM,
 *  split at an ODD byte boundary to exercise the sample-carry decoder. */
function fakeEngine(id: string, totalBytes: number, splitAt: number, onContext?: (c: TtsSynthesisContext) => void): TtsEngineSpec {
  return {
    id,
    voices: [],
    callBridge: true,
    synthesize: async () => ({ audio: Buffer.alloc(0), contentType: "audio/wav" }),
    synthesizeStream: async (context): Promise<TtsStream> => {
      onContext?.(context);
      const pcm = Buffer.alloc(totalBytes);
      for (let i = 0; i < totalBytes; i++) pcm[i] = i % 251;
      async function* frames(): AsyncGenerator<Buffer> {
        yield pcm.subarray(0, splitAt);
        yield pcm.subarray(splitAt);
      }
      return { format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }, frames: frames() };
    },
  };
}

/** Minimal client using Node's own global WebSocket — an independent
 *  implementation, so a clean run proves our handshake + framing are correct. */
function connect(url: string): Promise<WebSocket> {
  const ws = new (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket(url);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
}

test("bridge speaks Text+Eos back as Ready then 24kHz Audio frames, then closes", async () => {
  const engine = fakeEngine("faketts-e2e", 8_000, 3_001); // 4000 samples
  registerTtsEngine(engine);
  const bridge = new TtsCallBridge(deps);
  try {
    const { wsUrl } = await bridge.start(engine, "airy", VOICE_SETTINGS_DEFAULTS);
    const ws = await connect(`${wsUrl}/api/tts_streaming?voice=airy&format=PcmMessagePack`);

    const messages: Array<{ type: string; pcm?: number[] }> = [];
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
    ws.addEventListener("message", (event) => {
      messages.push(unpackMessage(new Uint8Array(event.data as ArrayBuffer)) as { type: string; pcm?: number[] });
    });

    ws.send(packMsg({ type: "Text", text: "Hello there, world." }));
    ws.send(packMsg({ type: "Eos" }));
    await Promise.race([closed, new Promise((_r, rej) => setTimeout(() => rej(new Error("timed out")), 5_000))]);

    assert.equal(messages[0]?.type, "Ready", "first frame is Ready");
    const audio = messages.filter((m) => m.type === "Audio");
    assert.ok(audio.length >= 1, "got audio frames");
    for (const frame of audio) assert.ok((frame.pcm?.length ?? 0) <= 1_920, "frames are <= one 80ms block");
    const totalSamples = audio.reduce((sum, m) => sum + (m.pcm?.length ?? 0), 0);
    assert.equal(totalSamples, 4_000, "every s16le sample surfaced (odd split carried)");
  } finally {
    bridge.stop();
  }
});

test("bridge aborts the in-flight synthesis when the caller barges in (socket close)", async () => {
  let captured: AbortSignal | undefined;
  const engine: TtsEngineSpec = {
    id: "faketts-bargein",
    voices: [],
    callBridge: true,
    synthesize: async () => ({ audio: Buffer.alloc(0), contentType: "audio/wav" }),
    synthesizeStream: async (context): Promise<TtsStream> => {
      captured = context.signal;
      // Never-ending until aborted: yields nothing, waits on the signal.
      async function* frames(): AsyncGenerator<Buffer> {
        await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
      return { format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }, frames: frames() };
    },
  };
  registerTtsEngine(engine);
  const bridge = new TtsCallBridge(deps);
  try {
    const { wsUrl } = await bridge.start(engine, undefined, VOICE_SETTINGS_DEFAULTS);
    const ws = await connect(`${wsUrl}/api/tts_streaming`);
    // Text + Eos starts synthesis of the whole turn; the fake stream hangs until
    // aborted, so closing the socket mid-synthesis is the barge-in.
    ws.send(packMsg({ type: "Text", text: "Speaking now, and still going." }));
    ws.send(packMsg({ type: "Eos" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(captured, "engine received an abort signal");
    assert.equal(captured?.aborted, true, "barge-in aborted the generation");
  } finally {
    bridge.stop();
  }
});

// --- duplex path: whole sentences fed as they stream -----------------------

/** A callBridge engine with duplex support: records each fed sentence and emits
 *  a fixed PCM frame per push, so the test can assert BOTH the sentence
 *  boundaries the bridge chose and that audio flows out per sentence. */
function fakeDuplexEngine(id: string, pushes: string[], onEnd: () => void): TtsEngineSpec {
  return {
    id,
    voices: [],
    callBridge: true,
    synthesize: async () => ({ audio: Buffer.alloc(0), contentType: "audio/wav" }),
    synthesizeDuplex: async (): Promise<TtsDuplexSession> => {
      let ctrl!: ReadableStreamDefaultController<Buffer>;
      const stream = new ReadableStream<Buffer>({ start: (c) => { ctrl = c; } });
      const frames = (async function* () {
        const reader = stream.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; }
      })();
      return {
        format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
        push: (text) => { pushes.push(text); ctrl.enqueue(Buffer.alloc(2_000)); }, // 1000 s16 samples
        end: () => { onEnd(); ctrl.close(); },
        frames,
      };
    },
  };
}

test("bridge feeds whole sentences to a duplex engine as they stream, ends on Eos", async () => {
  const pushes: string[] = [];
  let ended = 0;
  const engine = fakeDuplexEngine("faketts-duplex", pushes, () => { ended += 1; });
  registerTtsEngine(engine);
  const bridge = new TtsCallBridge(deps);
  try {
    const { wsUrl } = await bridge.start(engine, "airy", VOICE_SETTINGS_DEFAULTS);
    const ws = await connect(`${wsUrl}/api/tts_streaming?voice=airy`);
    const messages: Array<{ type: string; pcm?: number[] }> = [];
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
    ws.addEventListener("message", (event) => {
      messages.push(unpackMessage(new Uint8Array(event.data as ArrayBuffer)) as { type: string; pcm?: number[] });
    });
    // The second sentence's leading space is what completes the first — so a
    // sentence is only spoken once whole (never split mid-word into a "dot").
    ws.send(packMsg({ type: "Text", text: "Hello there." }));
    ws.send(packMsg({ type: "Text", text: " How are you?" }));
    ws.send(packMsg({ type: "Eos" }));
    await Promise.race([closed, new Promise((_r, rej) => setTimeout(() => rej(new Error("timed out")), 5_000))]);

    assert.deepEqual(pushes, ["Hello there.", "How are you?"], "fed as two whole sentences, in order");
    assert.equal(ended, 1, "Eos closed the duplex input exactly once");
    const total = messages.filter((m) => m.type === "Audio").reduce((sum, m) => sum + (m.pcm?.length ?? 0), 0);
    assert.equal(total, 2_000, "both sentences' PCM forwarded to unmute");
  } finally {
    bridge.stop();
  }
});

test("the claude duplex engine streams NDJSON text in (duplex request) and PCM out", async () => {
  const received: Array<{ text?: string; end?: boolean }> = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"loggedIn":true}'); return; }
    if (req.url?.startsWith("/stream-in")) {
      // Answer headers immediately (before the body) so the fetch resolves and
      // the caller can start pushing — the duplex contract. flushHeaders() is
      // required: Node buffers headers until the first body write otherwise.
      res.writeHead(200, { "content-type": "audio/pcm", "x-tts-rate": "16000", "x-tts-channels": "1", "x-tts-bits": "16" });
      res.flushHeaders();
      let buf = "";
      req.on("data", (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue; // the priming blank line
          const message = JSON.parse(line) as { text?: string; end?: boolean };
          received.push(message);
          if (message.end) res.end();
          else if (message.text) res.write(Buffer.alloc(320)); // 160 s16 samples per sentence
        }
      });
      req.on("end", () => { try { res.end(); } catch { /* already ended */ } });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const engine = findTtsEngine("claude");
    assert.ok(engine?.synthesizeDuplex, "claude advertises duplex");
    const settings = { ...VOICE_SETTINGS_DEFAULTS, claudeVoiceUrl: `http://127.0.0.1:${port}`, claudeVoiceDir: "" };
    const session = await engine.synthesizeDuplex({
      voice: "airy",
      settings,
      ensureTts: async () => ({ ttsUrl: "" }),
      log: () => {},
      signal: new AbortController().signal,
    });
    session.push("Hello.");
    session.push("World.");
    session.end();
    const frames: Buffer[] = [];
    for await (const frame of session.frames) frames.push(frame);
    assert.equal(frames.reduce((sum, f) => sum + f.length, 0), 640, "PCM for both fed lines streamed back");
    assert.deepEqual(received.filter((m) => m.text).map((m) => m.text), ["Hello.", "World."], "each sentence arrived as its own NDJSON line");
    assert.ok(received.some((m) => m.end === true), "the end signal was sent");
  } finally {
    server.close();
  }
});

test("the claude duplex engine waits for browser-session readiness before opening stream-in", async () => {
  let streamInHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"loggedIn":false}'); return; }
    if (req.url?.startsWith("/stream-in")) streamInHits++;
    res.writeHead(500); res.end("stream-in should not be called while the browser session is not ready");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const engine = findTtsEngine("claude");
    assert.ok(engine?.synthesizeDuplex, "claude advertises duplex");
    const settings = { ...VOICE_SETTINGS_DEFAULTS, claudeVoiceUrl: `http://127.0.0.1:${port}`, claudeVoiceDir: "", startTimeoutSec: 0.03 };
    await assert.rejects(
      () => engine.synthesizeDuplex!({
        voice: "airy",
        settings,
        ensureTts: async () => ({ ttsUrl: "" }),
        log: () => {},
        signal: new AbortController().signal,
      }),
      /browser session is not ready/,
    );
    assert.equal(streamInHits, 0);
  } finally {
    server.close();
  }
});

test("the claude read-aloud engine advertises callBridge (calls can use it)", () => {
  assert.equal(findTtsEngine("claude")?.callBridge, true);
  assert.equal(findTtsEngine("kyutai")?.callBridge, undefined, "kyutai stays the native call path");
});
