// @ts-nocheck — real readaloud.js + real stream synthesis service; fake browser/audio/network.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAloudStream, registerTtsEngine, speakableText } from '../src/services/read-aloud.ts';
import { VOICE_SETTINGS_DEFAULTS } from '../src/services/voice.ts';

let player, state, root, requests, syntheses, contexts, events, failures;
const saved = Object.fromEntries(['window', 'AudioContext', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'navigator', 'document', 'localStorage', 'addEventListener', 'removeEventListener'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
class FakeSource {
  onended = null;
  connect() {}
  start() {}
  stop() { this.stopped = true; }
  end() { const cb = this.onended; this.onended = null; cb?.(); }
}
class FakeContext {
  state = 'running'; currentTime = 0; destination = {}; sources = [];
  constructor() { contexts.push(this); }
  createBuffer(_channels, size) { const data = new Float32Array(size); return { getChannelData: () => data }; }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
const reply = (id, text = 'Reply.') => ({ type: 'room-event', workspaceId: 'workspace', roomId: 'room', event: { id, author: 'astra', text } });
const tick = () => new Promise(r => setTimeout(r, 0));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  throw new Error('fixture condition not reached');
}
const finish = (index = contexts.length - 1) => { for (const source of contexts[index].sources) source.end(); };
const engine = 'auto-browser-fixture';

beforeAll(async () => {
  setGlobal('window', { addEventListener() {} });
  setGlobal('requestAnimationFrame', () => 1);
  setGlobal('cancelAnimationFrame', () => {});
  player = await import('../web/src/readaloud.js');
  ({ state } = await import('../web/src/state.js'));
  registerTtsEngine({ id: engine, voices: [],
    synthesize: async () => { throw new Error('batch endpoint forbidden'); },
    synthesizeStream: async context => {
      syntheses.push(context.text);
      return { format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 },
        frames: (async function* () { yield Buffer.from([1, 0, 2, 0, 3, 0]); })() };
    },
  });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gaia-auto-browser-'));
  requests = []; syntheses = []; contexts = []; events = new Map(); failures = 0;
  setGlobal('AudioContext', FakeContext);
  let held = false;
  setGlobal('navigator', { locks: { request: async (_name, _options, callback) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({ name: 'gaia-auto-tts' }); } finally { held = false; }
  } } });
  // Hidden/unfocused → intentionally still eligible.
  setGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
  state.general.autoTts = true;
  state.snapshot = { workspace: { id: 'workspace' }, room: { id: 'room' } };
  state.error = '';
  setGlobal('fetch', async (url, init) => {
    requests.push({ url, init });
    if (failures) { failures--; return Response.json({ error: 'fixture failure' }, { status: 500 }); }
    const { eventId } = JSON.parse(init.body);
    const delivery = await readAloudStream({ event: events.get(eventId),
      settings: { ...VOICE_SETTINGS_DEFAULTS, ttsEngine: engine },
      ensureTts: async () => { throw new Error('fixture only'); },
      cacheDir: join(root, 'cache'), archiveDir: join(root, 'archive'),
    });
    if (delivery.mode !== 'stream') throw new Error('unexpected chunk mode');
    return new Response(new ReadableStream({ async start(controller) {
      for await (const frame of delivery.frames) controller.enqueue(frame);
      controller.close();
    } }), { headers: { 'x-tts-mode': 'stream', 'x-tts-rate': '16000', 'x-tts-channels': '1', 'x-tts-bits': '16' } });
  });
});
afterEach(async () => {
  player.disposeAutoReadAloud();
  player.stopReadAloud();
  await tick();
  await rm(root, { recursive: true, force: true });
});
afterAll(() => { for (const [key, descriptor] of Object.entries(saved)) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
} });

function enqueue(id, text) {
  const event = reply(id, text);
  events.set(id, event.event);
  return player.enqueueAutoReadAloud(event);
}

test('auto and manual → identical request, formatter, one synthesis + AudioTransport; hidden tab plays', async () => {
  const text = '**# Heading**\n' + 'A complete long sentence. '.repeat(1000) + '\nTHE END';
  const auto = enqueue('same', text);
  await until(() => contexts[0]?.sources.length && state.readAloud?.phase === 'playing');
  await tick();
  expect(syntheses).toEqual([speakableText(text)]);
  expect(syntheses[0].startsWith('# Heading')).toBe(true);
  expect(syntheses[0].endsWith('THE END')).toBe(true);
  expect(requests).toHaveLength(1);
  expect(contexts).toHaveLength(1);
  expect(requests[0].url).toBe('/api/workspaces/workspace/rooms/room/read-aloud/stream');
  expect(JSON.parse(requests[0].init.body)).toEqual({ eventId: 'same' });
  finish();
  await auto;
  expect(state.readAloud.phase).toBe('ended');
  player.stopReadAloud();
  player.toggleReadAloud('same');
  await until(() => contexts[1]?.sources.length);
  expect(requests).toHaveLength(2);
  expect(requests[1].url).toBe(requests[0].url);
  expect(requests[1].init.body).toBe(requests[0].init.body);
  expect(requests[1].init.method).toBe(requests[0].init.method);
  expect(requests[1].init.headers).toEqual(requests[0].init.headers);
  expect(syntheses).toHaveLength(1); // Same manual cache identity.
  finish();
});

test('two replies → two full syntheses, second starts only after first audio ends (not HTTP EOF)', async () => {
  const first = enqueue('first', 'First '.repeat(1000));
  const second = enqueue('second', 'Second '.repeat(1000));
  await until(() => contexts[0]?.sources.length);
  await tick(); await tick();
  expect(requests).toHaveLength(1);
  expect(syntheses).toHaveLength(1);
  finish(0);
  await until(() => contexts[1]?.sources.length);
  expect(contexts[0].state).toBe('closed');
  expect(syntheses).toEqual([speakableText(events.get('first').text), speakableText(events.get('second').text)]);
  finish(1);
  await Promise.all([first, second]);
  expect(requests).toHaveLength(2);
});

test('manual playing → auto skipped; manual interrupt of auto → queued auto skipped', async () => {
  events.set('manual', reply('manual', 'Manual speech.').event);
  player.toggleReadAloud('manual');
  await until(() => contexts[0]?.sources.length);
  await enqueue('skipped', 'Do not synthesize.');
  expect(requests).toHaveLength(1);
  player.stopReadAloud();
  const first = enqueue('auto', 'Automatic speech.');
  const queued = enqueue('queued', 'Also do not synthesize.');
  await until(() => contexts[1]?.sources.length);
  player.toggleReadAloud('manual');
  await Promise.all([first, queued]);
  expect(requests.map(r => JSON.parse(r.init.body).eventId)).toEqual(['manual', 'auto', 'manual']);
});

test('HTTP error and stop → queue settles; later reply still uses shared player', async () => {
  failures = 1;
  const first = enqueue('failed', 'Failure.');
  const second = enqueue('next', 'Next.');
  await first;
  await until(() => contexts.at(-1)?.sources.length);
  expect(state.error).toBe('fixture failure');
  player.stopReadAloud();
  await second;
  expect(requests).toHaveLength(2);
});

test('setting off / room switch while queued → no second synthesis', async () => {
  const first = enqueue('first', 'First.');
  const second = enqueue('second', 'Second.');
  await until(() => contexts[0]?.sources.length);
  state.snapshot.room.id = 'other';
  state.general.autoTts = false;
  finish();
  await Promise.all([first, second]);
  expect(requests).toHaveLength(1);
});

test('another tab owns Web Lock → no request or AudioTransport', async () => {
  setGlobal('navigator', { locks: { request: async (name, options, callback) => {
    expect(name).toBe('gaia-auto-tts');
    expect(options).toEqual({ ifAvailable: true });
    return callback(null);
  } } });
  await enqueue('not-owned', 'Skip.');
  expect(requests).toHaveLength(0);
  expect(contexts).toHaveLength(0);
});

test('fallback ownership lost during audio → stop active transport + skip queued reply', async () => {
  const values = new Map(), listeners = new Map();
  setGlobal('navigator', {});
  setGlobal('localStorage', { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
  setGlobal('addEventListener', (type, listener) => listeners.set(type, listener));
  setGlobal('removeEventListener', type => listeners.delete(type));
  const first = enqueue('first', 'First.');
  const second = enqueue('second', 'Second.');
  await until(() => contexts[0]?.sources.length);
  values.set('gaia-auto-tts-owner', JSON.stringify({ owner: 'other-tab', expiresAt: Date.now() + 60000 }));
  listeners.get('storage')({ key: 'gaia-auto-tts-owner' });
  await Promise.all([first, second]);
  expect(contexts[0].sources.every(source => source.stopped)).toBe(true);
  expect(contexts[0].state).toBe('closed');
  expect(state.readAloud).toBe(null);
  expect(requests).toHaveLength(1);
});

test('room navigation stops active auto but preserves active manual playback', async () => {
  const auto = enqueue('auto', 'Auto speech.');
  await until(() => contexts[0]?.sources.length);
  state.snapshot.room.id = 'other';
  player.initializeAutoReadAloud();
  await auto;
  expect(contexts[0].state).toBe('closed');
  events.set('manual', reply('manual', 'Manual speech.').event);
  player.toggleReadAloud('manual');
  await until(() => contexts[1]?.sources.length);
  state.snapshot.room.id = 'third';
  player.initializeAutoReadAloud();
  expect(contexts[1].state).toBe('running');
});
