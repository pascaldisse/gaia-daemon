// AudioTransport state machine (web/src/readaloud.js) — the stall bug lived
// here: playback stopped while audio was still arriving and nothing re-armed
// it. These tests drive the transport with a fake AudioContext, so they assert
// STATE (playing / userPaused / frontier), never sound.
import { test, expect, beforeAll } from "bun:test";

/** @type {any} */
let AudioTransport: any;
let ctxFailures = 0;
let contexts: FakeContext[] = [];

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect(): void {}
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  /** Simulate this scheduled buffer finishing playback. */
  end(): void { const cb = this.onended; this.onended = null; cb?.(); }
}

class FakeContext {
  state = "running";
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  constructor() {
    if (ctxFailures > 0) { ctxFailures -= 1; throw new Error("AudioContext unavailable"); }
    contexts.push(this);
  }
  createBuffer(_ch: number, length: number): { length: number; getChannelData: () => Float32Array } {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createBufferSource(): FakeSource { const src = new FakeSource(); this.sources.push(src); return src; }
  resume(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { this.state = "closed"; return Promise.resolve(); }
  /** Fire the state-change listener the transport installs. */
  setState(next: string): void { this.state = next; this.onstatechange?.(); }
}

const flush = async (): Promise<void> => { await new Promise<void>((r) => setTimeout(r, 0)); };
const pcm = (n: number): Float32Array => new Float32Array(n).fill(0.1);

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= {};
  g.AudioContext = FakeContext;
  const mod = await import("../web/src/readaloud.js");
  AudioTransport = (mod as Record<string, unknown>).AudioTransport;
});

function armed(): { t: any; ctx: FakeContext } {
  contexts = [];
  const t = new AudioTransport();
  t.setFormat(16000, 1);
  t.play(0);
  return { t, ctx: contexts[0] as FakeContext };
}

test("a late append is not stranded when the finish check races it", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000));
  t.markDone();
  // Last scheduled source ends, then the tail lands before the microtask.
  ctx.sources[0]?.end();
  t.append(pcm(8000));
  await flush();
  expect(t.playing).toBe(true);
  expect(t.frontier).toBe(t.total);
  expect(t.total).toBe(24000);
});

test("audio arriving after a finish re-arms playback (the 1:55-of-2:03 stall)", async () => {
  const { t, ctx } = armed();
  let ended = 0;
  t.onEnded = () => { ended += 1; };
  t.append(pcm(16000));
  t.markDone();
  ctx.sources[0]?.end();
  await flush();
  expect(t.playing).toBe(false);
  expect(ended).toBe(1);
  // The server was still streaming: the tail must play, not vanish.
  t.append(pcm(16000));
  expect(t.playing).toBe(true);
  expect(t.userPaused).toBe(false);
  expect(t.frontier).toBe(t.total);
});

test("a user pause stays paused when more audio arrives", async () => {
  const { t } = armed();
  t.append(pcm(16000));
  t.pause();
  expect(t.userPaused).toBe(true);
  t.append(pcm(16000));
  await flush();
  expect(t.playing).toBe(false);
  expect(t.userPaused).toBe(true);
});

test("play() clears userPaused so a resumed run re-arms again", async () => {
  const { t } = armed();
  t.append(pcm(16000));
  t.pause();
  t.play();
  expect(t.userPaused).toBe(false);
  t.pause();
  t.play();
  t.append(pcm(4000));
  expect(t.playing).toBe(true);
});

test("a pending append blocks the finish", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000));
  t.pendingAppends = 1; // a decode in flight (feedChunks)
  t.markDone();
  ctx.sources[0]?.end();
  await flush();
  expect(t.playing).toBe(true);
  t.pendingAppends = 0;
  t.append(pcm(4000));
  ctx.sources[1]?.end();
  await flush();
  expect(t.playing).toBe(false);
});

test("a context that stops running mid-play migrates instead of going silent", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000));
  ctx.setState("interrupted");
  await flush();
  expect(contexts.length).toBe(2);
  expect(t.ctx).toBe(contexts[1]);
  expect(t.ctx.state).toBe("running");
  expect(t.playing).toBe(true);
});

test("a paused context is left alone (no migration behind the user's back)", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000));
  t.pause();
  ctx.setState("suspended");
  await flush();
  expect(contexts.length).toBe(1);
  expect(t.playing).toBe(false);
});

test("a failed migration reports an error instead of leaving a closed context", async () => {
  const { t, ctx } = armed();
  await flush(); // drain play()'s async resume check so only migration errors land
  t.append(pcm(16000));
  const errors: unknown[] = [];
  t.onError = (error: unknown) => { errors.push(error); };
  ctxFailures = 1; // the replacement AudioContext cannot be built
  ctx.setState("interrupted");
  await flush();
  ctxFailures = 0;
  expect(errors.length).toBe(1);
  expect(String((errors[0] as Error).message)).toContain("AudioContext unavailable");
  expect(t.playing).toBe(false);
});
