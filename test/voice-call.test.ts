import { test, expect } from "bun:test";
import { VoiceCall } from "../web/src/voice-call.js";
import { voiceCallConfig, VOICE_CALL_DEFAULTS } from "../web/shared/voice-call-config.js";

const origin = { workspaceId: "voice-proof", roomId: "non-main" };
function reply(id: string, timestamp = 1001, scope = origin, author = "astra") {
  return { type: "room-event", ...scope, event: { id, timestamp: new Date(timestamp).toISOString(), author, text: `Reply ${id}` } } as any;
}
function fixture(delayed = false) {
  const spoken: string[] = [], sent: any[] = [], errors: unknown[] = [];
  let stopped = 0, audioStopped = 0;
  let deliver!: (text: string) => Promise<void>;
  let release!: () => void;
  let micSignal!: AbortSignal;
  const call = new VoiceCall({
    now: () => 1000,
    changed: () => {}, stopAudio: () => { audioStopped++; },
    speak: (id: string) => { spoken.push(id); }, error: (e: unknown) => { errors.push(e); },
    openMic: async (signal: AbortSignal, text: (text: string) => Promise<void>) => {
      deliver = text; micSignal = signal;
      if (delayed) await new Promise<void>(resolve => { release = resolve; });
      return () => { stopped++; };
    },
    send: async (text: string, room: any, signal: AbortSignal) => { sent.push({ text, room, signal }); },
  });
  return { call, spoken, sent, errors, deliver: (text: string) => deliver(text), release: () => release(), stopped: () => stopped, audioStopped: () => audioStopped, micSignal: () => micSignal };
}
test("explicit call only; cutoff, known events, author and room filters; three replies replace immediately without queue", async () => {
  const f = fixture(); f.call.reply(reply("before"));
  await f.call.start(origin, ["known"]);
  for (const event of [reply("old", 999), reply("boundary", 1000), reply("known"), reply("elsewhere", 1001, { ...origin, roomId: "other" }), reply("human", 1001, origin, "user")]) f.call.reply(event);
  for (const id of ["one", "two", "three", "three"]) f.call.reply(reply(id));
  expect(f.spoken).toEqual(["one", "two", "three"]);
  f.call.end(); f.call.reply(reply("after"));
  expect(f.spoken).toEqual(["one", "two", "three"]);
  expect(f.stopped()).toBe(1); expect(f.micSignal().aborted).toBe(true);
  expect(f.audioStopped()).toBe(2);
});
test("STT posts normal text to bound room; late STT after hangup is discarded", async () => {
  const f = fixture(); await f.call.start(origin);
  await f.deliver("my words"); f.call.end(); await f.deliver("late words");
  expect(f.sent.map(({ text, room }) => ({ text, room }))).toEqual([{ text: "my words", room: origin }]);
  expect(f.sent[0].signal.aborted).toBe(true);
});
test("hangup during permission prompt retires late microphone; new call cannot revive old one", async () => {
  const f = fixture(true); const pending = f.call.start(origin);
  f.call.end(); expect(f.micSignal().aborted).toBe(true);
  f.release(); await pending;
  expect(f.stopped()).toBe(1); expect(f.call.current).toBeNull();
  await f.deliver("late permission speech"); expect(f.sent).toEqual([]);
});
test("navigation ends call; fresh instance/reload has no session and replays nothing", async () => {
  const f = fixture(); await f.call.start(origin);
  f.call.navigate(origin); expect(f.call.current).not.toBeNull();
  f.call.navigate({ ...origin, workspaceId: "elsewhere" }); expect(f.call.current).toBeNull();
  const next = fixture(); next.call.reply(reply("history")); expect(next.spoken).toEqual([]);
});
test("voice.json call parameters are validated; malformed values cannot disable stop detection", () => {
  expect(voiceCallConfig(undefined)).toEqual(VOICE_CALL_DEFAULTS);
  const custom = voiceCallConfig({ silenceMs: 345, rmsThreshold: .04, ttsEngine: "claude", fftSize: 512 });
  expect(custom.silenceMs).toBe(345); expect(custom.rmsThreshold).toBe(.04); expect(custom.fftSize).toBe(512);
  expect(voiceCallConfig({ silenceMs: -1, rmsThreshold: NaN, fftSize: 100 }).silenceMs).toBe(VOICE_CALL_DEFAULTS.silenceMs);
  expect(voiceCallConfig({ fftSize: 100 }).fftSize).toBe(VOICE_CALL_DEFAULTS.fftSize);
});
