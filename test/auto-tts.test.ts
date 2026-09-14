import { expect, mock, test } from "bun:test";
import { AutoTtsQueue, playAutoTtsAudio } from "../src/services/auto-tts.js";
import { claudeVoiceHealth, type ReadAloudRequest, type ReadAloudResult } from "../src/services/read-aloud.js";
import { VOICE_SETTINGS_DEFAULTS } from "../src/services/voice.js";
import type { UiEvent } from "../src/core/types.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reply(text = "Hello.", id = "reply-1"): Extract<UiEvent, { type: "room-event" }> {
  return { type: "room-event", workspaceId: "workspace", roomId: "room", event: { id, author: "astra", timestamp: "2026-09-14T00:00:00Z", text } };
}

function audio(chunk = 0, chunks = 1): ReadAloudResult {
  return { audio: Buffer.from("audio"), contentType: "audio/wav", chunk, chunks, identity: { engine: "claude", voice: "airy", model: "", textHash: "hash" } };
}

function setup(enabled = true) {
  const state = { enabled, healthy: true };
  const readAloud = mock(async (_request: ReadAloudRequest) => audio());
  const play = mock(async (_result: ReadAloudResult, _signal: AbortSignal) => {});
  const healthy = mock(async (_url: string) => state.healthy);
  const log = mock((_message: string) => {});
  const request = mock(async (event: Extract<UiEvent, { type: "room-event" }>) => ({
    event: event.event,
    settings: VOICE_SETTINGS_DEFAULTS,
    ensureTts: async () => ({ ttsUrl: "unused" }),
  }));
  const queue = new AutoTtsQueue({ enabled: async () => state.enabled, request, readAloud, healthy, play, log });
  return { queue, state, readAloud, play, healthy, log, request };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("setting off: no read-aloud, health, or playback calls", async () => {
  const s = setup(false);
  await s.queue.enqueue(reply());
  expect(s.readAloud).toHaveBeenCalledTimes(0);
  expect(s.healthy).toHaveBeenCalledTimes(0);
  expect(s.play).toHaveBeenCalledTimes(0);
});

test("setting on: one existing read-aloud call with stripped final text", async () => {
  const s = setup();
  await s.queue.enqueue(reply("<gaia:think>private</gaia:think>\n# **Hello** [you](https://example.com).\n```ts\nsecret();\n```\nUse `done`."));
  expect(s.readAloud).toHaveBeenCalledTimes(1);
  expect(s.readAloud.mock.calls[0][0].event).toEqual({ author: "astra", text: "Hello you.\n(ts code omitted)\nUse done." });
  expect(s.play).toHaveBeenCalledTimes(1);
});

test("two room replies: FIFO waits for playback completion before second synthesis", async () => {
  const s = setup();
  const started = deferred();
  const release = deferred();
  s.play.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
  const first = s.queue.enqueue(reply("First."));
  const second = s.queue.enqueue({ ...reply("Second.", "reply-2"), roomId: "other-room" });
  await started.promise;
  expect(s.readAloud).toHaveBeenCalledTimes(1);
  expect(s.play).toHaveBeenCalledTimes(1);
  release.resolve();
  await Promise.all([first, second]);
  expect(s.readAloud.mock.calls.map(([r]) => r.event.text)).toEqual(["First.", "Second."]);
  expect(s.play).toHaveBeenCalledTimes(2);
});

test("non-final events, special kinds, blank and thinking-only text: ignored", async () => {
  const s = setup();
  for (const author of ["user", "system", "tool"]) await s.queue.enqueue({ ...reply(), event: { ...reply().event, author } });
  for (const kind of ["compact-complete", "turn-failed", "plugin-reply", "capability-denied"] as const) {
    await s.queue.enqueue({ ...reply(), event: { ...reply().event, kind } });
  }
  await s.queue.enqueue({ type: "text-delta", workspaceId: "workspace", roomId: "room", agentId: "astra", taskId: "task", eventId: "reply-1", delta: "delta" });
  await s.queue.enqueue(reply(" \n "));
  await s.queue.enqueue(reply("<gaia:think>hidden</gaia:think>"));
  expect(s.readAloud).toHaveBeenCalledTimes(0);
});

test("unhealthy claude-voice: skip and log without starting synthesis", async () => {
  const s = setup();
  s.state.healthy = false;
  await s.queue.enqueue(reply());
  expect(s.readAloud).toHaveBeenCalledTimes(0);
  expect(s.log.mock.calls[0][0]).toContain("not healthy");
});

test("read-aloud failures are logged; next reply still speaks", async () => {
  const s = setup();
  s.readAloud.mockRejectedValueOnce(new Error("synthesis failed"));
  await Promise.all([s.queue.enqueue(reply("First.")), s.queue.enqueue(reply("Second."))]);
  expect(s.log.mock.calls[0][0]).toContain("synthesis failed");
  expect(s.readAloud).toHaveBeenCalledTimes(2);
  expect(s.play).toHaveBeenCalledTimes(1);
});

test("playback failure plus failing logger cannot poison queue", async () => {
  const s = setup();
  s.play.mockRejectedValueOnce(new Error("player failed"));
  s.log.mockImplementation(() => { throw new Error("logger failed"); });
  await Promise.all([s.queue.enqueue(reply("First.")), s.queue.enqueue(reply("Second."))]);
  expect(s.readAloud).toHaveBeenCalledTimes(2);
  expect(s.play).toHaveBeenCalledTimes(2);
});

test("existing chunk count drives sequential playback of the whole reply", async () => {
  const s = setup();
  s.readAloud.mockImplementation(async (request) => audio(request.chunk, 3));
  await s.queue.enqueue(reply("Long reply."));
  expect(s.readAloud.mock.calls.map(([r]) => r.chunk)).toEqual([0, 1, 2]);
  expect(s.play.mock.calls.map(([r]) => r.chunk)).toEqual([0, 1, 2]);
});

test("disable while playing: queued replies discarded", async () => {
  const s = setup();
  const started = deferred();
  const release = deferred();
  s.play.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
  const first = s.queue.enqueue(reply());
  const second = s.queue.enqueue(reply("Second."));
  await started.promise;
  s.state.enabled = false;
  release.resolve();
  await Promise.all([first, second]);
  expect(s.readAloud).toHaveBeenCalledTimes(1);
});

test("dispose aborts active playback and discards queued replies", async () => {
  const s = setup();
  const started = deferred();
  s.play.mockImplementationOnce(async (_result, signal) => {
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const first = s.queue.enqueue(reply());
  const second = s.queue.enqueue(reply("Second."));
  await started.promise;
  s.queue.dispose();
  await Promise.all([first, second, s.queue.enqueue(reply("Third."))]);
  expect(s.readAloud).toHaveBeenCalledTimes(1);
});

test("health probe: configured URL, ok false, logged-out, malformed, HTTP failure", async () => {
  let body: unknown = { ok: true, loggedIn: true, voice: "airy" };
  let status = 200;
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return Response.json(body, { status });
  } });
  try {
    expect(await claudeVoiceHealth(server.url.origin)).toMatchObject({ ok: true, ready: true });
    body = { ok: false, loggedIn: true };
    expect(await claudeVoiceHealth(server.url.origin)).toMatchObject({ ok: false, ready: false });
    body = { ok: true, loggedIn: false };
    expect(await claudeVoiceHealth(server.url.origin)).toMatchObject({ ok: true, ready: false });
    body = null;
    expect((await claudeVoiceHealth(server.url.origin)).ok).toBe(false);
    status = 503;
    expect(await claudeVoiceHealth(server.url.origin)).toMatchObject({ ok: false, ready: false });
    expect(paths).toEqual(Array(5).fill("/health"));
  } finally { await server.stop(true); }
});

test("audio sink: player spawn failure cleans temporary audio", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-auto-tts-player-test-"));
  try {
    await expect(playAutoTtsAudio(audio(), new AbortController().signal, join(root, "missing-player"), root)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("default health guard rejects ok:false without invoking read-aloud", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: false, loggedIn: true }) });
  const readAloud = mock(async (_request: ReadAloudRequest) => audio());
  const log = mock((_message: string) => {});
  const queue = new AutoTtsQueue({
    enabled: async () => true,
    request: async (event) => ({ event: event.event, settings: { ...VOICE_SETTINGS_DEFAULTS, claudeVoiceUrl: server.url.origin }, ensureTts: async () => ({ ttsUrl: "unused" }) }),
    readAloud,
    log,
  });
  try {
    await queue.enqueue(reply());
    expect(readAloud).toHaveBeenCalledTimes(0);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { queue.dispose(); await server.stop(true); }
});

test("settings/request failures resolve safely without poisoning later replies", async () => {
  const s = setup();
  s.request.mockRejectedValueOnce(new Error("workspace unavailable"));
  await s.queue.enqueue(reply());
  await s.queue.enqueue(reply("Next."));
  expect(s.log.mock.calls[0][0]).toContain("workspace unavailable");
  expect(s.readAloud).toHaveBeenCalledTimes(1);
  const queue = new AutoTtsQueue({ ...s, enabled: async () => { throw new Error("settings unavailable"); } });
  await queue.enqueue(reply());
  expect(s.log.mock.calls.at(-1)?.[0]).toContain("settings unavailable");
  expect(s.readAloud).toHaveBeenCalledTimes(1);
});
