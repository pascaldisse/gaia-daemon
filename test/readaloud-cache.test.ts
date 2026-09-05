import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAloud, readAloudStream, registerTtsEngine, resolveTtsChoice, ttsCacheKey, type ReadAloudRequest, type TtsSynthesisContext } from "../src/services/read-aloud.js";
import { VOICE_SETTINGS_DEFAULTS } from "../src/services/voice.js";

const format = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };
async function fixture(run: (request: ReadAloudRequest, calls: string[]) => Promise<void>) {
  const base = join(import.meta.dir, "../.gaia/readaloud-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "cache-"));
  const calls: string[] = [];
  const id = `cache-test-${dir.split("/").pop()}`;
  const render = (ctx: TtsSynthesisContext) => {
    const text = `${ctx.voice}:${ctx.model}:${ctx.text}`;
    calls.push(text);
    return Buffer.from(text);
  };
  registerTtsEngine({
    id, voices: ["airy", "mellow"],
    resolveVoice: (voice, settings) => voice ?? settings.claudeVoice,
    resolveModel: (model, settings) => model ?? settings.elevenLabsModel,
    synthesize: async (ctx) => ({ audio: render(ctx), contentType: "audio/test" }),
    synthesizeStream: async (ctx) => ({ format, frames: (async function* () { yield render(ctx); })() }),
  });
  try {
    await run({ event: { author: "gaia", text: "Same message." }, settings: { ...VOICE_SETTINGS_DEFAULTS, ttsEngine: id, claudeVoice: "airy", elevenLabsModel: "model-a" }, ensureTts: async () => { throw new Error("unexpected external TTS"); }, cacheDir: join(dir, "cache"), archiveDir: join(dir, "archive") }, calls);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function stream(request: ReadAloudRequest) {
  const result = await readAloudStream(request);
  if (result.mode !== "stream") throw new Error("expected streaming engine");
  const frames: Buffer[] = [];
  for await (const frame of result.frames) frames.push(frame);
  return { audio: Buffer.concat(frames).toString(), identity: result.identity };
}

test("cache key separates voice, model, text, engine and framing; model defaults explicitly", () => {
  const key = ttsCacheKey("claude", "airy", "Hello.");
  expect(key).toBe(ttsCacheKey("claude", "airy", "Hello.", "default"));
  const keys = [key, ttsCacheKey("claude", "mellow", "Hello."), ttsCacheKey("claude", "airy", "Hello.", "new-model"), ttsCacheKey("claude", "airy", "Changed."), ttsCacheKey("other", "airy", "Hello."), ttsCacheKey("claude:stream", "airy", "Hello.")];
  expect(new Set(keys).size).toBe(keys.length);
  expect(ttsCacheKey("a\nb", "c", "d")).not.toBe(ttsCacheKey("a", "b\nc", "d"));
});

for (const mode of ["chunks", "stream"] as const) {
  test(`${mode}: voice change busts cache; identical voice replays; model/text changes miss`, async () => {
    await fixture(async (request, calls) => {
      const render = mode === "stream" ? stream : async (r: ReadAloudRequest) => { const a = await readAloud(r); return { audio: a.audio.toString(), identity: a.identity }; };
      const airy = await render(request);
      expect((await render(request)).audio).toBe(airy.audio);
      expect(calls.length).toBe(1);
      const mellow = await render({ ...request, voice: "mellow" });
      expect(mellow.identity.voice).toBe("mellow");
      expect(mellow.audio).not.toBe(airy.audio);
      expect((await render({ ...request, voice: "mellow" })).audio).toBe(mellow.audio);
      expect(calls.length).toBe(2);
      await render({ ...request, settings: { ...request.settings, claudeVoice: "mellow" } });
      expect(calls.length).toBe(2);
      expect((await render({ ...request, model: "model-b" })).audio).toContain("model-b");
      expect(calls.length).toBe(3);
      await render({ ...request, settings: { ...request.settings, elevenLabsModel: "model-b" } });
      expect(calls.length).toBe(3);
      await render({ ...request, event: { ...request.event, text: "Changed message." } });
      expect(calls.length).toBe(4);
      await render({ ...request, regenerate: true });
      expect(calls.length).toBe(5);
    });
  });

  test(`${mode}: legacy metadata without voice is a miss even at the current filename`, async () => {
    await fixture(async (request, calls) => {
      const render = mode === "stream" ? stream : async (r: ReadAloudRequest) => { const a = await readAloud(r); return { audio: a.audio.toString(), identity: a.identity }; };
      const fresh = await render(request);
      const files = await readdir(request.cacheDir!);
      const path = join(request.cacheDir!, files.find(n => n.endsWith(".json"))!);
      const meta = JSON.parse(await readFile(path, "utf8"));
      expect(meta.identity.textHash).toBe(createHash("sha256").update("Same message.").digest("hex"));
      delete meta.identity.voice;
      await writeFile(path, JSON.stringify(meta));
      await writeFile(path.replace(/\.json$/, ".audio"), "OLD WRONG VOICE");
      expect((await render(request)).audio).toBe(fresh.audio);
      expect(calls.length).toBe(2);
      delete meta.identity;
      await writeFile(path, JSON.stringify(meta));
      await render(request);
      expect(calls.length).toBe(3);
    });
  });
}

test("ElevenLabs resolves configured fallback voice and model before cache lookup", () => {
  const settings = { ...VOICE_SETTINGS_DEFAULTS, ttsEngine: "elevenlabs", elevenLabsVoice: "voice-a", elevenLabsModel: "model-a" };
  expect(resolveTtsChoice(undefined, settings)).toMatchObject({ voice: "voice-a", model: "model-a" });
  expect(resolveTtsChoice(undefined, settings, { voice: "voice-b", model: "model-b" })).toMatchObject({ voice: "voice-b", model: "model-b" });
  expect(resolveTtsChoice(undefined, { ...settings, ttsEngine: "claude" })).toMatchObject({ voice: "airy", model: "default" });
  expect(() => resolveTtsChoice(undefined, { ...settings, ttsEngine: "claude" }, { model: "unsupported" })).toThrow("does not support model overrides");
});

test("browser replay and close/reopen re-resolve server voice instead of eventId-only PCM", async () => {
  const g = globalThis as any;
  const saved = { AudioContext: g.AudioContext, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame, fetch: g.fetch };
  g.window ??= {};
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  const contexts: any[] = [];
  g.AudioContext = class {
    state = "running"; currentTime = 0; destination = {}; sources: any[] = [];
    constructor() { contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    createBuffer(_n: number, size: number) { const pcm = new Float32Array(size); return { getChannelData: () => pcm }; }
    createBufferSource() { const source = { connect() {}, start() {}, stop() {}, onended: null }; this.sources.push(source); return source; }
  };
  const { toggleReadAloud, stopReadAloud } = await import("../web/src/readaloud.js");
  const { state } = await import("../web/src/state.js");
  const oldSnapshot = state.snapshot;
  let voice = "airy";
  const requests: string[] = [];
  g.fetch = async (url: string) => {
    requests.push(`${url}:${voice}`);
    return new Response(new Uint8Array([voice === "airy" ? 1 : 2, 0]), { headers: { "x-tts-mode": "stream", "x-tts-voice": voice } });
  };
  const settle = () => new Promise(r => setTimeout(r, 10));
  try {
    state.snapshot = { workspace: { id: "ws-a" }, room: { id: "room-a" } } as any;
    toggleReadAloud("event-1");
    await settle();
    contexts.at(-1).sources[0].onended();
    await settle();
    expect(state.readAloud?.phase).toBe("ended");
    voice = "mellow";
    toggleReadAloud("event-1");
    await settle();
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain(":mellow");
    stopReadAloud();
    toggleReadAloud("event-1");
    await settle();
    expect(requests.length).toBe(3);
    state.snapshot = { workspace: { id: "ws-b" }, room: { id: "room-b" } } as any;
    toggleReadAloud("event-1");
    await settle();
    expect(requests.length).toBe(4);
    expect(requests[3]).toContain("/workspaces/ws-b/rooms/room-b/");
  } finally {
    stopReadAloud();
    state.snapshot = oldSnapshot;
    Object.assign(g, saved);
  }
});
