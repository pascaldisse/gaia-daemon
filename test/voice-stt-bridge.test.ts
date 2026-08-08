import test from "node:test";
import assert from "node:assert/strict";
import {
  EnergyVad,
  float32ToWav,
  STT_SAMPLE_RATE,
  SttCallBridge,
  type SttBridgeDeps,
} from "../src/services/voice-stt-bridge.js";
import { unpackMessage } from "../src/services/read-aloud.js";
import { packMsg } from "../src/services/voice-tts-bridge.js";
import { VOICE_SETTINGS_DEFAULTS } from "../src/services/voice.js";

function connect(url: string): Promise<WebSocket> {
  const ws = new (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket(url);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => { console.log("STT OPEN"); resolve(ws); }, { once: true });
    ws.addEventListener("error", () => { console.log("STT WS ERROR"); reject(new Error("ws error")); }, { once: true });
  });
}

function waitFor<T>(ws: WebSocket, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 5_000);
    ws.addEventListener("message", (event) => {
      const message = unpackMessage(new Uint8Array(event.data as ArrayBuffer)) as T;
      if (predicate(message)) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

test("EnergyVad chunks speech only after its 600ms silence window", () => {
  const vad = new EnergyVad(0.01, 6);
  assert.deepEqual(vad.push(Float32Array.of(0.1, 0.1)), { speech: true, boundary: false });
  assert.deepEqual(vad.push(Float32Array.of(0, 0)), { speech: false, boundary: false });
  assert.deepEqual(vad.push(Float32Array.of(0, 0, 0, 0)), { speech: false, boundary: true });
  assert.deepEqual(vad.push(Float32Array.of(0, 0)), { speech: false, boundary: false });
});

test("float32ToWav writes signed 16-bit 24kHz PCM WAV", () => {
  const wav = float32ToWav(Float32Array.of(-1, 0, 1));
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt32LE(24), STT_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(44), -32767);
  assert.equal(wav.readInt16LE(48), 32767);
});

test("bridge emits Ready, Step, sequential Word/EndWord, then Marker after Replicate flush", async () => {
  const requests: Array<{ bytes: number; engineId?: string; aborted: boolean }> = [];
  const deps: SttBridgeDeps = {
    log: () => {},
    transcribe: async (request) => {
      requests.push({ bytes: request.audio.data.length, engineId: request.engineId, aborted: request.signal?.aborted ?? false });
      return { text: "hello bridge", engine: "replicate" };
    },
  };
  const bridge = new SttCallBridge(deps);
  try {
    const { wsUrl } = await bridge.start(VOICE_SETTINGS_DEFAULTS);
    const ws = await connect(`${wsUrl}/api/asr-streaming`);
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => { console.log("STT RAW", event.data); const message = unpackMessage(new Uint8Array(event.data as ArrayBuffer)) as Record<string, unknown>; console.log("stt msg", message); messages.push(message); });
    console.log("STT BEFORE WAIT");
    const marked = waitFor<Record<string, unknown>>(ws, (message) => message.type === "Marker" && message.id === 17);
    console.log("STT AFTER WAIT");

    const speech = Array.from({ length: 1_920 }, () => 0.2);
    const silence = Array.from({ length: 1_920 }, () => 0);
    console.log("STT SEND");
    ws.send(packMsg({ type: "Audio", pcm: speech }));
    // 8 * 80ms = 640ms: enough quiet to cut an utterance after speech.
    for (let i = 0; i < 8; i++) ws.send(packMsg({ type: "Audio", pcm: silence }));
    ws.send(packMsg({ type: "Marker", id: 17 }));
    console.log("STT SENT");

    await marked;
    assert.equal(requests.length, 1, "one VAD utterance was sent to shared transcribe path");
    assert.equal(requests[0]?.engineId, "replicate", "call bridge forces Replicate, not dictation setting");
    assert.equal(requests[0]?.bytes, 44 + 9 * 1_920 * 2, "WAV contains speech plus silence window");
    assert.equal(messages[0]?.type, "Ready");
    const steps = messages.filter((message) => message.type === "Step");
    assert.equal(steps.length, 9, "one Step per incoming Audio frame");
    assert.equal((steps[0]?.prs as number[])[2], 0, "speech reports no pause");
    assert.equal((steps[1]?.prs as number[])[2], 1, "silence reports pause");
    const words = messages.filter((message) => message.type === "Word");
    assert.deepEqual(words.map((word) => word.text), ["hello ", "bridge"]);
    assert.ok((words[0]?.start_time as number) < (words[1]?.start_time as number), "word times are monotonic");
    assert.equal(messages.findIndex((message) => message.type === "EndWord") < messages.findIndex((message) => message.type === "Marker"), true, "marker follows transcription flush");
    ws.close();
  } finally {
    bridge.stop();
  }
});
