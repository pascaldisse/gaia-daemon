import { expect, mock, test } from "bun:test";
import { Daemon } from "../src/daemon.js";
import type { UiEvent } from "../src/core/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAloudStream, registerTtsEngine, speakableText } from "../src/services/read-aloud.js";
import { VOICE_SETTINGS_DEFAULTS } from "../src/services/voice.js";

// No daemon startup, player process, real voice helper, or app settings mutation.
test("committed broadcast: event delivery only; no daemon auto playback hook", () => {
  const emit = mock((_event: UiEvent) => {});
  const host = {
    bus: { emit },
    get interactions() { throw new Error("broadcast must not invoke TTS"); },
  };
  const event: UiEvent = { type: "room-event", workspaceId: "workspace", roomId: "room", event: {
    id: "reply", author: "astra", timestamp: "2026-09-14T00:00:00Z", text: "Reply.",
  } };
  Daemon.prototype.broadcast.call(host as unknown as Daemon, event);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(event);
});

test("daemon auto audio service removed, not retained as dead code", async () => {
  expect(await Bun.file(new URL("../src/services/auto-tts.ts", import.meta.url)).exists()).toBe(false);
});

test("manual stream service: long full reply → one synthesis; no second formatting or text cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-auto-stream-test-"));
  const text = '<gaia:think>private</gaia:think>\n# **Hello**\n' + 'A long complete sentence. '.repeat(1000) + '\n`**literal**`\nEND';
  const synthesize = mock(async () => ({ audio: Buffer.from("unused"), contentType: "audio/wav" }));
  const synthesizeStream = mock(async (_context: { text: string }) => ({
    format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 },
    frames: (async function* () { yield Buffer.from([1, 0, 2, 0]); })(),
  }));
  const engine = `auto-stream-${root.split('/').pop()}`;
  registerTtsEngine({ id: engine, voices: [], synthesize, synthesizeStream });
  try {
    const delivery = await readAloudStream({
      event: { author: "astra", text }, settings: { ...VOICE_SETTINGS_DEFAULTS, ttsEngine: engine },
      ensureTts: async () => { throw new Error("fixture only"); }, cacheDir: join(root, 'cache'), archiveDir: join(root, 'archive'),
    });
    expect(delivery.mode).toBe('stream');
    if (delivery.mode === 'stream') for await (const _frame of delivery.frames) { /* Drain cache tee. */ }
    expect(synthesize).toHaveBeenCalledTimes(0);
    expect(synthesizeStream).toHaveBeenCalledTimes(1);
    expect(synthesizeStream.mock.calls[0][0].text).toBe(speakableText(text));
    expect(synthesizeStream.mock.calls[0][0].text.endsWith('END')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
