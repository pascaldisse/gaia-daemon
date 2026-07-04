import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseTtsConfig } from "../src/core/config.js";
import {
  packMessage,
  pcmToWav,
  readAloud,
  readAloudStream,
  registerTtsEngine,
  resolveTtsChoice,
  speakableText,
  splitSpeechChunks,
  ttsEngineIds,
  unpackMessage,
  type TtsStream,
  type TtsSynthesisContext,
} from "../src/services/read-aloud.js";
import { VOICE_SETTINGS_DEFAULTS, VoiceStackManager, type SpawnedService, type VoiceSettings, type VoiceStackSettings } from "../src/services/voice.js";
import { createTempDir } from "./helpers/temp.js";

function voiceSettings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return { ...VOICE_SETTINGS_DEFAULTS, ...overrides };
}

// ---------------------------------------------------------------------------
// speakableText — deterministic markdown→speech formatting

test("speakableText: code fences are omitted, inline code keeps its content", () => {
  const text = speakableText("Run `npm test` first.\n\n```ts\nconst x = 1;\n```\n\nDone.");
  assert.equal(text, "Run npm test first.\n(ts code omitted)\nDone.");
});

test("speakableText: links speak their label, bare URLs collapse, images speak alt text", () => {
  const text = speakableText("See [the docs](https://example.com/a?b=1) and https://example.com/raw plus ![a chart](img.png).");
  assert.equal(text, "See the docs and (link) plus a chart.");
});

test("speakableText: headings, lists, blockquotes, emphasis and rules are stripped", () => {
  const text = speakableText("# Title\n\n> quoted\n\n- **bold item**\n2) _second_\n\n---\n\nplain ~~gone~~ end");
  assert.equal(text, "Title\nquoted\nbold item\nsecond\nplain gone end");
});

test("speakableText: tables turn into comma pauses without separator rows", () => {
  const text = speakableText("| name | value |\n| --- | --- |\n| a | 1 |");
  assert.equal(text, "name, value\na, 1");
});

test("speakableText: emojis vanish and whitespace collapses", () => {
  assert.equal(speakableText("Ship it 🚀🔥   now\n\n\nplease ✨"), "Ship it now\nplease");
  assert.equal(speakableText("🚀 ✨"), "");
});

test("speakableText: long messages are spoken in full, never truncated (like the desktop app)", () => {
  const text = speakableText(`${"word ".repeat(3000)}tail`);
  assert.ok(text.length > 14_000);
  assert.ok(text.endsWith("tail"));
  assert.ok(!text.includes("truncated"));
});

// ---------------------------------------------------------------------------
// msgpack — the unmute TTS wire subset

test("msgpack: pack/unpack round-trips string maps (incl. long strings)", () => {
  const short = { type: "Text", text: "héllo wörld" };
  assert.deepEqual(unpackMessage(packMessage(short)), short);
  const long = { type: "Text", text: "x".repeat(70_000) };
  assert.deepEqual(unpackMessage(packMessage(long)), long);
});

test("msgpack: decodes the server's Audio frames (fixmap + array + float32)", () => {
  // {type:"Audio", pcm:[0.5, -0.25]} exactly as msgpack-python packs it with
  // use_single_float=True.
  const bytes = Buffer.concat([
    Buffer.from([0x82]),
    Buffer.from([0xa4]),
    Buffer.from("type", "utf8"),
    Buffer.from([0xa5]),
    Buffer.from("Audio", "utf8"),
    Buffer.from([0xa3]),
    Buffer.from("pcm", "utf8"),
    Buffer.from([0x92]),
    (() => {
      const buffer = Buffer.alloc(10);
      buffer[0] = 0xca;
      buffer.writeFloatBE(0.5, 1);
      buffer[5] = 0xca;
      buffer.writeFloatBE(-0.25, 6);
      return buffer;
    })(),
  ]);
  assert.deepEqual(unpackMessage(bytes), { type: "Audio", pcm: [0.5, -0.25] });
});

test("msgpack: decodes ints, negative fixints, bools, nil and float64", () => {
  const bytes = Buffer.concat([
    Buffer.from([0x95]), // fixarray(5)
    Buffer.from([0x07]), // 7
    Buffer.from([0xe0]), // -32
    Buffer.from([0xc3]), // true
    Buffer.from([0xc0]), // nil
    (() => {
      const buffer = Buffer.alloc(9);
      buffer[0] = 0xcb;
      buffer.writeDoubleBE(1.5, 1);
      return buffer;
    })(),
  ]);
  assert.deepEqual(unpackMessage(bytes), [7, -32, true, null, 1.5]);
});

// ---------------------------------------------------------------------------
// WAV wrapping

test("pcmToWav: writes a correct RIFF header around the samples", () => {
  const pcm = Buffer.alloc(4800);
  const wav = pcmToWav(pcm, 24_000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(28), 48_000); // byte rate = rate * 2 bytes mono
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

// ---------------------------------------------------------------------------
// engine resolution — engines are data, resolution never branches on ids

test("engines: kyutai and claude are registered", () => {
  assert.ok(ttsEngineIds().includes("kyutai"));
  assert.ok(ttsEngineIds().includes("claude"));
});

test("resolveTtsChoice: workspace default engine, agent tts override, voice fallback chain", () => {
  const settings = voiceSettings();
  assert.equal(resolveTtsChoice(undefined, settings).engine.id, "kyutai");

  const agent = { voice: "unmute-prod-website/p329_022.wav", tts: { engine: "claude", voice: "airy" } };
  const choice = resolveTtsChoice(agent, settings);
  assert.equal(choice.engine.id, "claude");
  assert.equal(choice.voice, "airy");

  // No tts.voice → the agent's call voice doubles as the read-aloud voice.
  assert.equal(resolveTtsChoice({ voice: "some-voice" }, settings).voice, "some-voice");
  assert.throws(() => resolveTtsChoice({ tts: { engine: "nope" } }, settings), /Unknown TTS engine "nope"/);
});

test("parseTtsConfig: object form, string shorthand, junk rejected", () => {
  assert.deepEqual(parseTtsConfig({ engine: " claude ", voice: "airy" }), { engine: "claude", voice: "airy" });
  assert.deepEqual(parseTtsConfig("claude:airy"), { engine: "claude", voice: "airy" });
  assert.deepEqual(parseTtsConfig("kyutai"), { engine: "kyutai" });
  assert.equal(parseTtsConfig(42), undefined);
  assert.equal(parseTtsConfig({}), undefined);
  assert.equal(parseTtsConfig({ engine: 3 }), undefined);
});

// ---------------------------------------------------------------------------
// speech chunking — long messages play as sentence-packed pieces

test("splitSpeechChunks: short text is one chunk, sentences never split", () => {
  assert.deepEqual(splitSpeechChunks("Hello world."), ["Hello world."]);
  const chunks = splitSpeechChunks("One two three. Four five six! Seven eight?", 20);
  assert.deepEqual(chunks, ["One two three.", "Four five six!", "Seven eight?"]);
});

test("splitSpeechChunks: sentences pack up to the cap and overlong sentences break on commas/spaces", () => {
  const packed = splitSpeechChunks("Aaa. Bbb. Ccc. Ddd.", 10);
  assert.deepEqual(packed, ["Aaa. Bbb.", "Ccc. Ddd."]);

  const long = `${"word ".repeat(200)}end.`;
  const chunks = splitSpeechChunks(long, 400);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " ").trim());
});

test("splitSpeechChunks: the first chunks ramp up small so playback starts fast", () => {
  const chunks = splitSpeechChunks(`${"word ".repeat(200)}end.`);
  assert.ok(chunks[0].length <= 120);
  assert.ok(chunks[1].length <= 200);
  assert.ok(chunks[2].length <= 300);
  // An explicit cap below the ramp wins everywhere.
  assert.ok(splitSpeechChunks("word ".repeat(30), 40).every((chunk) => chunk.length <= 40));
});

// ---------------------------------------------------------------------------
// the shared read-aloud path

test("readAloud: refuses user messages and empty speakable text, then routes to the engine", async () => {
  const temp = await createTempDir();
  const calls: TtsSynthesisContext[] = [];
  registerTtsEngine({
    id: "test-fake",
    voices: [],
    synthesize: async (context) => {
      calls.push(context);
      return { audio: Buffer.from("AUDIO"), contentType: "audio/test" };
    },
  });
  const settings = voiceSettings({ ttsEngine: "test-fake" });
  const ensureTts = async () => ({ ttsUrl: "http://127.0.0.1:1" });

  try {
    await assert.rejects(() => readAloud({ event: { author: "user", text: "hi" }, settings, ensureTts }), /Only agent messages/);
    await assert.rejects(() => readAloud({ event: { author: "gaia", text: "🚀" }, settings, ensureTts }), /Nothing to read aloud/);

    const result = await readAloud({
      event: { author: "gaia", text: "**Hello** `world`" },
      agent: { tts: { voice: "airy" } },
      settings,
      ensureTts,
      cacheDir: temp.path,
    });
    assert.equal(result.contentType, "audio/test");
    assert.equal(result.chunks, 1);
    assert.equal(result.chunk, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "Hello world");
    assert.equal(calls[0].voice, "airy");
  } finally {
    await temp.cleanup();
  }
});

test("readAloud: chunked messages synthesize per chunk, cache replays without the engine", async () => {
  const temp = await createTempDir();
  const spoken: string[] = [];
  registerTtsEngine({
    id: "test-chunky",
    voices: [],
    synthesize: async (context) => {
      spoken.push(context.text);
      return { audio: Buffer.from(`AUDIO:${context.text}`), contentType: "audio/test" };
    },
  });
  const settings = voiceSettings({ ttsEngine: "test-chunky" });
  const ensureTts = async () => ({ ttsUrl: "http://127.0.0.1:1" });
  // Well past one chunk (first chunks ramp up small, so several pieces).
  const text = `${"alpha ".repeat(60)}one. ${"beta ".repeat(60)}two.`;
  const request = { event: { author: "gaia", text }, settings, ensureTts, cacheDir: temp.path };

  try {
    const first = await readAloud({ ...request, chunk: 0 });
    assert.ok(first.chunks > 1);
    const second = await readAloud({ ...request, chunk: 1 });
    assert.equal(second.chunk, 1);
    assert.deepEqual(spoken.length, 2);
    assert.notEqual(first.audio.toString(), second.audio.toString());

    // Replay: both chunks come from the disk cache; the engine stays silent.
    const replay = await readAloud({ ...request, chunk: 0 });
    assert.equal(replay.audio.toString(), first.audio.toString());
    assert.equal(replay.contentType, "audio/test");
    assert.equal(spoken.length, 2);

    await assert.rejects(
      () => readAloud({ ...request, chunk: 99 }),
      new RegExp(`Unknown chunk 99 \\(message has ${first.chunks}\\)`),
    );
  } finally {
    await temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// readAloudStream — the desktop-app streaming path, dispatched on the engine's
// capability (never its id)

async function collect(frames: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const frame of frames) parts.push(Buffer.from(frame));
  return Buffer.concat(parts);
}

test("readAloudStream: a batch-only engine reports chunks, so the client keeps the per-chunk path", async () => {
  const temp = await createTempDir();
  registerTtsEngine({
    id: "test-batch-only",
    voices: [],
    synthesize: async () => ({ audio: Buffer.from("AUDIO"), contentType: "audio/test" }),
  });
  const settings = voiceSettings({ ttsEngine: "test-batch-only" });
  const ensureTts = async () => ({ ttsUrl: "http://127.0.0.1:1" });
  const text = `${"alpha ".repeat(60)}one. ${"beta ".repeat(60)}two.`;

  try {
    const delivery = await readAloudStream({ event: { author: "gaia", text }, settings, ensureTts, cacheDir: temp.path });
    assert.equal(delivery.mode, "chunks");
    if (delivery.mode !== "chunks") throw new Error("unreachable");
    assert.equal(delivery.chunks, splitSpeechChunks(speakableText(text)).length);
    assert.ok(delivery.chunks > 1);
  } finally {
    await temp.cleanup();
  }
});

test("readAloudStream: a streaming engine synthesizes the whole message once, frames stream through, then replay hits the cache", async () => {
  const temp = await createTempDir();
  let synths = 0;
  const seen: string[] = [];
  registerTtsEngine({
    id: "test-streamer",
    voices: [],
    synthesize: async () => ({ audio: Buffer.from("AUDIO"), contentType: "audio/test" }),
    synthesizeStream: async (context): Promise<TtsStream> => {
      synths++;
      seen.push(context.text);
      const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // 4 s16le samples
      return {
        format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 },
        frames: (async function* () {
          yield pcm.subarray(0, 4);
          yield pcm.subarray(4, 8);
        })(),
      };
    },
  });
  const settings = voiceSettings({ ttsEngine: "test-streamer" });
  const ensureTts = async () => ({ ttsUrl: "http://127.0.0.1:1" });
  // Long enough that the batch path WOULD have chunked it — proving the stream
  // path speaks the whole message in one pass instead.
  const text = `${"alpha ".repeat(60)}one. ${"beta ".repeat(60)}two.`;
  const request = { event: { author: "gaia", text }, settings, ensureTts, cacheDir: temp.path };

  try {
    const first = await readAloudStream(request);
    assert.equal(first.mode, "stream");
    if (first.mode !== "stream") throw new Error("unreachable");
    assert.deepEqual(first.format, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    const audio = await collect(first.frames);
    assert.equal(audio.length, 8);
    assert.equal(synths, 1);
    assert.equal(seen[0], speakableText(text)); // whole message, not a chunk

    // Replay: the whole-message PCM comes from the disk cache; no re-synthesis.
    const replay = await readAloudStream(request);
    assert.equal(replay.mode, "stream");
    if (replay.mode !== "stream") throw new Error("unreachable");
    assert.equal((await collect(replay.frames)).toString("hex"), audio.toString("hex"));
    assert.equal(synths, 1);
  } finally {
    await temp.cleanup();
  }
});

test("readAloudStream: an aborted stream is not cached (no truncated replay)", async () => {
  const temp = await createTempDir();
  let synths = 0;
  registerTtsEngine({
    id: "test-streamer-abort",
    voices: [],
    synthesize: async () => ({ audio: Buffer.from("AUDIO"), contentType: "audio/test" }),
    synthesizeStream: async (): Promise<TtsStream> => {
      synths++;
      return {
        format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 },
        frames: (async function* () {
          yield Buffer.from([1, 0]);
          yield Buffer.from([2, 0]);
          yield Buffer.from([3, 0]);
        })(),
      };
    },
  });
  const settings = voiceSettings({ ttsEngine: "test-streamer-abort" });
  const ensureTts = async () => ({ ttsUrl: "http://127.0.0.1:1" });
  const request = { event: { author: "gaia", text: "Hello there friend." }, settings, ensureTts, cacheDir: temp.path };

  try {
    const first = await readAloudStream(request);
    if (first.mode !== "stream") throw new Error("expected stream");
    // Consume only the first frame, then break — simulates a client hang-up.
    for await (const _frame of first.frames) break;

    // Nothing was cached, so a second call re-synthesizes (no partial replay).
    const second = await readAloudStream(request);
    if (second.mode !== "stream") throw new Error("expected stream");
    assert.equal((await collect(second.frames)).length, 6);
    assert.equal(synths, 2);
  } finally {
    await temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// stack: ensureTts (the kyutai engine's service bring-up)

class FakeService implements SpawnedService {
  pid = 123;
  exited = false;
  killed = false;
  kill(): void {
    this.killed = true;
    this.exited = true;
  }
  onExit(): void {}
}

function stackSettings(overrides: Partial<VoiceStackSettings> = {}): VoiceStackSettings {
  return {
    unmuteDir: "/tmp/does-not-matter",
    unmuteUrl: "ws://127.0.0.1:8000",
    autoStart: true,
    startTimeoutMs: 2000,
    ...overrides,
  };
}

test("ensureTts: reuses an external TTS service without spawning", async () => {
  const temp = await createTempDir();
  try {
    const spawned: string[] = [];
    const manager = new VoiceStackManager(temp.path, {
      probePort: async () => true,
      probeHttpOk: async () => true,
      spawnService: (spec) => {
        spawned.push(spec.name);
        return new FakeService();
      },
    });
    const result = await manager.ensureTts(stackSettings(), () => {});
    assert.equal(result.ttsUrl, "http://127.0.0.1:8089");
    assert.deepEqual(spawned, []);
  } finally {
    await temp.cleanup();
  }
});

test("ensureTts: spawns the TTS service when its port is free and waits for health", async () => {
  const temp = await createTempDir();
  const unmute = await createTempDir();
  try {
    await mkdir(join(unmute.path, "macos"), { recursive: true });
    let up = false;
    const spawned: string[] = [];
    const manager = new VoiceStackManager(temp.path, {
      probePort: async () => false,
      probeHttpOk: async () => up,
      pollIntervalMs: 5,
      spawnService: (spec) => {
        spawned.push(spec.name);
        setTimeout(() => (up = true), 10);
        return new FakeService();
      },
    });
    const result = await manager.ensureTts(stackSettings({ unmuteDir: unmute.path }), () => {});
    assert.equal(result.ttsUrl, "http://127.0.0.1:8089");
    assert.deepEqual(spawned, ["tts"]);
    assert.deepEqual(manager.spawnedServices, ["tts"]);
  } finally {
    await unmute.cleanup();
    await temp.cleanup();
  }
});

test("ensureTts: refuses to spawn when auto-start is disabled", async () => {
  const temp = await createTempDir();
  try {
    const manager = new VoiceStackManager(temp.path, { probePort: async () => false, probeHttpOk: async () => false });
    await assert.rejects(() => manager.ensureTts(stackSettings({ autoStart: false }), () => {}), /auto-start is disabled/);
  } finally {
    await temp.cleanup();
  }
});
