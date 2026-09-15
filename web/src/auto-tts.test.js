// @ts-nocheck — Bun fixtures; queue contract, no browser/audio side effects.
import { expect, mock, test } from 'bun:test';
import { AutoTtsQueue } from './auto-tts.js';

const reply = (id = 'one', text = 'Hello.') => ({ type: 'room-event', workspaceId: 'ws', roomId: 'room', event: { id, author: 'astra', text } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const state = { enabled: true, owns: true, manual: false, origin: { workspaceId: 'ws', roomId: 'room' } };
  const play = mock(async () => {});
  const log = mock(() => {});
  const acquire = mock(async () => state.owns);
  const queue = new AutoTtsQueue({ policy: "enqueue", enabled: () => state.enabled, current: () => state.origin, acquire,
    owns: () => state.owns, manualBusy: () => state.manual, play, log });
  return { state, play, log, acquire, queue };
}

test('off/non-final/empty/user/system/tool/special-kind → no playback', async () => {
  const s = setup();
  s.state.enabled = false;
  await s.queue.enqueue(reply());
  s.state.enabled = true;
  for (const author of ['user', 'system', 'tool']) await s.queue.enqueue({ ...reply(), event: { ...reply().event, author } });
  await s.queue.enqueue({ type: 'text-delta' });
  await s.queue.enqueue(reply('empty', ' \n '));
  await s.queue.enqueue({ ...reply(), event: { ...reply().event, kind: 'compact-complete' } });
  expect(s.play).toHaveBeenCalledTimes(0);
  expect(s.acquire).toHaveBeenCalledTimes(0);
});

test('one full reply → one event-ID playback; no auto-side text preparation', async () => {
  const s = setup();
  const event = reply('long', '<gaia:think>hidden</gaia:think>\n**# Heading**\n' + 'Full sentence. '.repeat(1000));
  const original = event.event.text;
  await s.queue.enqueue(event);
  expect(s.play.mock.calls).toEqual([['long', { workspaceId: 'ws', roomId: 'room' }]]);
  expect(event.event.text).toBe(original);
});

test('two replies → FIFO includes actual playback completion', async () => {
  const s = setup();
  const started = deferred(), release = deferred();
  s.play.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
  const first = s.queue.enqueue(reply());
  const second = s.queue.enqueue(reply('two'));
  await started.promise;
  expect(s.play).toHaveBeenCalledTimes(1);
  release.resolve();
  await Promise.all([first, second]);
  expect(s.play.mock.calls.map(([id]) => id)).toEqual(['one', 'two']);
});

test('manual busy on arrival → skip, not deferred until manual ends', async () => {
  const s = setup();
  s.state.manual = true;
  const pending = s.queue.enqueue(reply());
  s.state.manual = false;
  await pending;
  expect(s.play).toHaveBeenCalledTimes(0);
});

test('background workspace/room → skip + console-compatible log', async () => {
  const s = setup();
  await s.queue.enqueue({ ...reply(), roomId: 'other' });
  await s.queue.enqueue({ ...reply(), workspaceId: 'other' });
  expect(s.play).toHaveBeenCalledTimes(0);
  expect(s.log.mock.calls.every(([line]) => line.includes('background room skipped'))).toBe(true);
  expect(s.log).toHaveBeenCalledTimes(2);
});

test('queued reply rechecks room, setting, ownership, manual priority, disposal', async () => {
  for (const change of [s => s.state.origin.roomId = 'other', s => s.state.enabled = false,
    s => s.state.owns = false, s => s.state.manual = true, s => s.queue.dispose()]) {
    const s = setup();
    const started = deferred(), release = deferred();
    s.play.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const first = s.queue.enqueue(reply());
    const second = s.queue.enqueue(reply('two'));
    await started.promise;
    change(s);
    release.resolve();
    await Promise.all([first, second]);
    expect(s.play).toHaveBeenCalledTimes(1);
  }
});

test('non-owner and duplicate final events → never duplicate speech', async () => {
  const s = setup();
  s.state.owns = false;
  await s.queue.enqueue(reply('not-owned'));
  expect(s.play).toHaveBeenCalledTimes(0);
  s.state.owns = true;
  await Promise.all([s.queue.enqueue(reply()), s.queue.enqueue(reply())]);
  expect(s.play).toHaveBeenCalledTimes(1);
});

test('playback/acquisition/log failures → next reply remains usable', async () => {
  const s = setup();
  s.acquire.mockRejectedValueOnce(new Error('lock failed'));
  s.play.mockRejectedValueOnce(new Error('audio failed'));
  s.log.mockImplementation(() => { throw new Error('log failed'); });
  await s.queue.enqueue(reply('lock'));
  await s.queue.enqueue(reply('audio'));
  await s.queue.enqueue(reply('next'));
  expect(s.play.mock.calls.map(([id]) => id)).toEqual(['audio', 'next']);
});

test('default replace → latest arrival supersedes pending ownership without waiting for old audio', async () => {
  const played = [], ownership = deferred(), oldAudio = deferred();
  const queue = new AutoTtsQueue({ enabled: () => true, current: () => ({workspaceId:'ws',roomId:'room'}),
    acquire: () => ownership.promise, owns: () => true, manualBusy: () => false,
    play: async id => { played.push(id); if(id === 'old') await oldAudio.promise; } });
  const old = queue.enqueue(reply('old')); ownership.resolve(true);
  await new Promise(r => setTimeout(r, 0)); expect(played).toEqual(['old']);
  await queue.enqueue(reply('new')); expect(played).toEqual(['old','new']);
  oldAudio.resolve(); await old;
});

test('default replace → pending burst plays latest only; disposal suppresses late ownership', async () => {
  const played = [], ownership = deferred();
  const deps = { enabled: () => true, current: () => ({workspaceId:'ws',roomId:'room'}),
    acquire: () => ownership.promise, owns: () => true, manualBusy: () => false, play: async id => { played.push(id); } };
  const queue = new AutoTtsQueue(deps);
  const first = queue.enqueue(reply('first')), next = queue.enqueue(reply('next'));
  ownership.resolve(true); await Promise.all([first,next]); expect(played).toEqual(['next']);
  const stopped = new AutoTtsQueue(deps); const pending = stopped.enqueue(reply('stopped'));
  stopped.dispose(); await pending; expect(played).toEqual(['next']);
});
