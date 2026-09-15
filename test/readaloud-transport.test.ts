// AudioTransport state machine (web/src/readaloud.js) — the stall bug lived
// here: playback stopped while audio was still arriving and nothing re-armed
// it. These tests drive the transport with a fake AudioContext, so they assert
// STATE (playing / userPaused / frontier), never sound.
import { test, expect, beforeAll, afterEach } from "bun:test";

/** @type {any} */
let AudioTransport: any;
let ctxFailures = 0;
let contexts: FakeContext[] = [];
const transports: any[] = [];
afterEach(() => { for (const t of transports.splice(0)) t.destroy(); ctxFailures = 0; });

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
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
  resumes = 0;
  resume(): Promise<void> { this.resumes++; this.state = "running"; return Promise.resolve(); }
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
  transports.push(t);
  t.setFormat(16000, 1);
  t.play(0);
  return { t, ctx: contexts[0] as FakeContext };
}

test("a late append is not stranded when the finish check races it", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000), t.requestId);
  t.markDone(t.requestId);
  // Last scheduled source ends, then the tail lands before the microtask.
  ctx.sources[0]?.end();
  t.append(pcm(8000), t.requestId);
  await flush();
  expect(t.playing).toBe(true);
  expect(t.frontier).toBe(t.total);
  expect(t.total).toBe(24000);
});

test("audio arriving after a finish re-arms playback (the 1:55-of-2:03 stall)", async () => {
  const { t, ctx } = armed();
  let ended = 0;
  t.onEnded = () => { ended += 1; };
  t.append(pcm(16000), t.requestId);
  t.markDone(t.requestId);
  ctx.sources[0]?.end();
  await flush();
  expect(t.playing).toBe(false);
  expect(ended).toBe(1);
  // The server was still streaming: the tail must play, not vanish.
  t.append(pcm(16000), t.requestId);
  expect(t.playing).toBe(true);
  expect(t.userPaused).toBe(false);
  expect(t.frontier).toBe(t.total);
});

test("a user pause stays paused when more audio arrives", async () => {
  const { t } = armed();
  t.append(pcm(16000), t.requestId);
  t.pause();
  expect(t.userPaused).toBe(true);
  t.append(pcm(16000), t.requestId);
  await flush();
  expect(t.playing).toBe(false);
  expect(t.userPaused).toBe(true);
});

test("play() clears userPaused so a resumed run re-arms again", async () => {
  const { t } = armed();
  t.append(pcm(16000), t.requestId);
  t.pause();
  t.play();
  expect(t.userPaused).toBe(false);
  t.pause();
  t.play();
  t.append(pcm(4000), t.requestId);
  expect(t.playing).toBe(true);
});

test("a pending append blocks the finish", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000), t.requestId);
  t.pendingAppends = 1; // a decode in flight (feedChunks)
  t.markDone(t.requestId);
  ctx.sources[0]?.end();
  await flush();
  expect(t.playing).toBe(true);
  t.pendingAppends = 0;
  t.append(pcm(4000), t.requestId);
  ctx.sources[1]?.end();
  await flush();
  expect(t.playing).toBe(false);
});

test("an interruption rebuilds the context and retains buffered PCM", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000), t.requestId);
  ctx.setState("interrupted");
  await flush();
  expect(contexts.length).toBe(2);
  expect(t.ctx).not.toBe(ctx);
  expect(ctx.state).toBe("closed");
  expect(t.total).toBe(16000);
  expect(t.frontier).toBe(16000);
  expect(t.ctx.state).toBe("running");
  expect(t.playing).toBe(true);
});

test("a paused context is left alone (no migration behind the user's back)", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000), t.requestId);
  t.pause();
  ctx.setState("suspended");
  await flush();
  expect(contexts.length).toBe(1);
  expect(t.playing).toBe(false);
});

test("a failed migration reports an error instead of leaving a closed context", async () => {
  const { t, ctx } = armed();
  await flush(); // drain play()'s async resume check so only migration errors land
  t.append(pcm(16000), t.requestId);
  const errors: unknown[] = [];
  t.onError = (error: unknown) => { errors.push(error); };
  ctxFailures = 1; // the replacement AudioContext cannot be built
  await t.migrateContext();
  ctxFailures = 0;
  expect(errors.length).toBe(1);
  expect(String((errors[0] as Error).message)).toContain("AudioContext unavailable");
  expect(t.playing).toBe(false);
});


test("pending autoplay resumes are retried inside a later gesture; PCM survives", async () => {
  const { t, ctx } = armed();
  t.append(pcm(160000), t.requestId);
  ctx.state = 'suspended';
  let grant!: () => void;
  ctx.resume = () => new Promise<void>(resolve => { grant = resolve; });
  t.recover('focus');
  const pending = grant;
  t.recover('pointerdown');
  expect(grant).not.toBe(pending);
  ctx.state = 'running'; grant(); await flush();
  expect(t.total).toBe(160000);
  expect(t.sources.size).toBe(1);
  expect(contexts).toHaveLength(1);
});

test("watchdog frozen running clock rebuilds after configured observation window", async () => {
  const { t, ctx } = armed();
  t.append(pcm(160000), t.requestId);
  const baseline = t._lastProgressAt = 1000;
  t.checkProgress(baseline + 1999);
  expect(contexts).toHaveLength(1);
  t.checkProgress(baseline + 2000);
  await flush();
  expect(contexts).toHaveLength(2);
  expect(ctx.state).toBe('closed');
  expect(t.rebuilds).toBe(1);
  t.ctx.currentTime = 1;
  t.checkProgress(t._lastProgressAt + 2001);
  expect(t.status).toBe('');
  expect(t.stalledRebuilds).toBe(0);
});

test("watchdog ignores download underruns and intentional pauses", async () => {
  const { t, ctx } = armed();
  t.checkProgress(t._lastProgressAt + 10000); // No PCM yet.
  expect(ctx.resumes).toBe(0);
  t.append(pcm(160000), t.requestId); t.pause(); ctx.state = 'suspended';
  t.checkProgress(t._lastProgressAt + 10000); t.recover('pointerdown');
  expect(ctx.resumes).toBe(0);
  expect(t._watchdog).toBe(null);
});

test("running-but-frozen clock rebinds once, preserving the unsounded tail", async () => {
  const { t, ctx } = armed();
  t.append(pcm(160000), t.requestId); ctx.currentTime = 4.08;
  t.checkProgress(t._lastProgressAt + 2001); // Establish healthy clock window.
  t.checkProgress(t._lastProgressAt + 2001); // Next window frozen.
  await flush();
  expect(contexts).toHaveLength(2);
  expect(t.anchorSample).toBe(64000);
  expect(t.frontier).toBe(160000);
  expect(ctx.state).toBe('closed');
});

test("destroy during device migration cannot resurrect an obsolete player", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000), t.requestId);
  let closed!: () => void;
  ctx.close = () => new Promise<void>(r => { closed = r; });
  const moving = t.migrateContext();
  t.destroy(false); closed(); await moving;
  expect(contexts).toHaveLength(1);
  expect(t.playing).toBe(false);
  t.append(pcm(8000), t.requestId); t.play();
  expect(t.total).toBe(0); // destroyed request PCM released, not retained
  expect(t.sources.size).toBe(0);
});

test("append + EOF during migration cannot finish before rebound audio", async () => {
  const { t, ctx } = armed();
  t.append(pcm(16000), t.requestId);
  let closed!: () => void;
  ctx.close = () => new Promise<void>(r => { closed = r; });
  const moving = t.migrateContext();
  t.append(pcm(8000), t.requestId); t.markDone(t.requestId); await flush();
  expect(t.playing).toBe(true);
  expect(t.sources.size).toBe(0);
  closed(); await moving;
  expect(t.frontier).toBe(24000);
  expect(t.sources.size).toBe(1);
});

test("user pause during migration survives completion; explicit resume remains possible", async () => {
  const { t, ctx } = armed(); t.append(pcm(160000), t.requestId); ctx.currentTime = 3.08;
  let closed!: () => void;
  ctx.close = () => new Promise<void>(r => { closed = r; });
  const moving = t.migrateContext(); t.pause(); closed(); await moving;
  expect(t.playing).toBe(false); expect(t.userPaused).toBe(true);
  expect(t.sources.size).toBe(0); expect(t.currentTime).toBe(3);
  t.play(); expect(t.anchorSample).toBe(48000);
});

test("a replacement transport adopts the unlocked context; old callbacks stay retired", () => {
  const { t, ctx } = armed(); t.append(pcm(16000), t.requestId); t.destroy(false);
  const next = new AudioTransport({ context: ctx }); transports.push(next);
  next.append(pcm(16000), next.requestId); next.play();
  expect(contexts).toHaveLength(1); expect(t.sources.size).toBe(0);
  expect(next.sources.size).toBe(1); expect(ctx.state).toBe('running');
});

test('a hung context close becomes a bounded visible failure, not an immortal migrating player', async () => {
  const {t,ctx}=armed();t.append(pcm(16000), t.requestId);t.contextCloseTimeoutMs=5;
  ctx.close=()=>new Promise<void>(()=>{});const errors:unknown[]=[];t.onError=(e:unknown)=>errors.push(e);
  await t.migrateContext();expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain('rebind timed out');expect(t.playing).toBe(false);
  expect(t._watchdog).toBe(null);expect(contexts).toHaveLength(1);
});

test('autoplay-blocked PCM remains unscheduled until output is actually running', async () => {
  contexts=[];const ctx=new FakeContext();ctx.state='suspended';let grant!:()=>void;
  ctx.resume=()=>new Promise<void>(r=>{grant=r;});
  const t=new AudioTransport({context:ctx});transports.push(t);t.setFormat(16000,1);t.play();t.append(pcm(16000), t.requestId);t.markDone(t.requestId);
  expect(t.sources.size).toBe(0);expect(t.frontier).toBe(0);expect(t.playing).toBe(true);
  ctx.setState('running');grant();await flush();expect(t.sources.size).toBe(1);expect(t.frontier).toBe(16000);
});

test('two consecutive frozen replacements → terminal dead status; no third rebuild or rearm', async () => {
  const {t,ctx}=armed();t.append(pcm(160000), t.requestId);ctx.currentTime=2.08;
  t.checkProgress(t._lastProgressAt+2001);
  let dead=0;t.onDead=()=>dead++;
  for (let attempt=1;attempt<=2;attempt++) {
    t.checkProgress(t._lastProgressAt+2001);await flush();
    expect(t.rebuilds).toBe(attempt);expect(t.playing).toBe(true);
    expect(t.anchorSample).toBe(32000);expect(t.currentTime).toBe(2);
  }
  t.checkProgress(t._lastProgressAt+2001);await flush();
  expect(contexts).toHaveLength(3);expect(t.rebuilds).toBe(2);expect(dead).toBe(1);
  expect(t.outputDead).toBe(true);expect(t.status).toBe('audio dead — click ⟳');
  expect(t.playing).toBe(false);expect(t.sources.size).toBe(0);expect(t._watchdog).toBe(null);
  t.ctx.currentTime=50;t.append(pcm(16000), t.requestId);t.play();t.recover('focus');
  expect(t.currentTime).toBe(2);expect(t.playing).toBe(false);
});

test('successful replacement output resets the consecutive failure budget', async () => {
  const {t}=armed();t.append(pcm(160000), t.requestId);
  await t.rebuildDeadOutput();expect(t.stalledRebuilds).toBe(1);
  t.ctx.currentTime=0.5;t.checkProgress(t._lastProgressAt+2001);
  expect(t.stalledRebuilds).toBe(0);
  await t.rebuildDeadOutput();expect(t.stalledRebuilds).toBe(1);expect(t.outputDead).toBe(false);
});

test('clock advance below minimum → rebuild; sample captures state, wall, latency and scheduled cursor', async () => {
  const {t,ctx}=armed();t.append(pcm(160000), t.requestId);
  Object.assign(ctx,{outputLatency:0.12});ctx.currentTime=0.49;
  const wall=t._lastProgressAt+2001;t.checkProgress(wall);
  expect(t.outputSample).toEqual({state:'running',ctxTime:0.49,wallTime:wall,outputLatency:0.12,cursor:160000});
  await flush();expect(t.rebuilds).toBe(1);
});

test('non-running context → immediate rebuild even before observation window', async () => {
  const {t,ctx}=armed();t.append(pcm(160000), t.requestId);ctx.state='suspended';
  t.checkProgress(t._lastProgressAt+1);await flush();
  expect(ctx.state).toBe('closed');expect(t.rebuilds).toBe(1);
});

test('real watchdog timer fires without rAF or direct checkProgress calls', async () => {
  const t=new AudioTransport({watchdogMs:5,stallSeconds:0.01,minClockAdvanceSeconds:0.002});transports.push(t);
  t.append(pcm(160000), t.requestId);t.play();
  const deadline=performance.now()+1000;
  while(!t.outputDead && performance.now()<deadline) await new Promise(r=>setTimeout(r,5));
  expect(t.rebuilds).toBe(2);expect(t.outputDead).toBe(true);expect(t._watchdog).toBe(null);
});

test('devicechange shares rebuild guard, preserves tail, ignores pause, detaches on destroy', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
  const devices=new EventTarget();Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:devices});
  try {
    const {t,ctx}=armed();t.append(pcm(160000), t.requestId);ctx.currentTime=3.08;
    devices.dispatchEvent(new Event('devicechange'));devices.dispatchEvent(new Event('devicechange'));
    await flush();expect(t.rebuilds).toBe(1);expect(t.anchorSample).toBe(48000);
    t.pause();devices.dispatchEvent(new Event('devicechange'));await flush();expect(t.rebuilds).toBe(1);
    t.destroy();devices.dispatchEvent(new Event('devicechange'));await flush();expect(t.rebuilds).toBe(1);
  } finally {
    if(descriptor) Object.defineProperty(navigator,'mediaDevices',descriptor);
    else delete (navigator as any).mediaDevices;
  }
});

test('frozen clock + incoming bytes/wall time → no progress; only scheduled ctx time advances', async () => {
  const {t,ctx}=armed();t.append(pcm(160000), t.requestId);ctx.currentTime=2.08;
  expect(t.currentTime).toBe(2);
  t.append(pcm(160000), t.requestId);t.checkProgress(t._lastProgressAt+1000);
  expect(t.currentTime).toBe(2);expect(t.duration).toBe(20);
  ctx.currentTime=3.08;expect(t.currentTime).toBe(3);
  t.pause();ctx.currentTime=99;expect(t.currentTime).toBe(3);
});

test('unscheduled PCM and scheduling lead cannot advance or rewind the playhead', async () => {
  const {t,ctx}=armed();t.append(pcm(160000), t.requestId);t.play(48000);
  expect(t.currentTime).toBe(3);
  ctx.currentTime=1.08;expect(t.currentTime).toBe(4);
  t.frontier=64000;ctx.currentTime=8;expect(t.currentTime).toBe(4);
});

test('context construction/close failures expose dead status rather than silently advancing', async () => {
  const {t}=armed();t.append(pcm(160000), t.requestId);ctxFailures=1;
  await t.rebuildDeadOutput();expect(t.outputDead).toBe(true);expect(t.status).toBe('audio dead — click ⟳');
  expect(t.playing).toBe(false);expect(t.sources.size).toBe(0);
});


test("A frozen → B starts → old resume/decode cannot emit A; stopped nodes disconnect and release PCM", async () => {
  const a = new AudioTransport({ requestId: "A" }); transports.push(a);
  a.setFormat(16000, 1); a.append(new Float32Array(16000).fill(0.25), "A"); a.play();
  const old = a.ctx.sources[0];
  let resume!: () => void;
  a.ctx.state = "suspended";
  a.ctx.resume = () => new Promise<void>(resolve => { resume = resolve; });
  a.recover();
  a.destroy(false); // exercise even the strongest hazard: shared resurrected context
  const b = new AudioTransport({ context: a.ctx, requestId: "B" }); transports.push(b);
  b.setFormat(16000, 1);
  b.append(new Float32Array(16000).fill(0.25), "A");
  expect(b.total).toBe(0);
  b.append(new Float32Array(16000).fill(0.25)); // missing request ID rejected too
  expect(b.total).toBe(0);
  b.append(new Float32Array(16000).fill(-0.5), "B");
  b.markDone("A"); expect(b.done).toBe(false);
  a.append(new Float32Array(16000).fill(0.25), "A");
  a.ctx.state = "running"; resume(); await flush(); b.play();
  expect(old.stopped).toBe(true); expect(old.disconnected).toBe(true); expect(old.buffer).toBeNull();
  expect(a.segments.length).toBe(0); expect(a.total).toBe(0);
  expect(a.playing).toBe(false); expect(b.total).toBe(16000);
  const live = [...b.sources] as FakeSource[];
  expect(live.length).toBe(1);
  expect([...(live[0].buffer as {getChannelData(): Float32Array}).getChannelData()]).toEqual([...new Float32Array(16000).fill(-0.5)]);
  await b.rebuildDeadOutput();
  expect(live[0].disconnected).toBe(true); expect(live[0].buffer).toBeNull();
  expect([...b._read(0, b.total)]).toEqual([...new Float32Array(16000).fill(-0.5)]);
});
