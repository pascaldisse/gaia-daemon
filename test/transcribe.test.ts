import test from "node:test";
import assert from "node:assert/strict";
import {
  findSttEngine,
  registerSttEngine,
  resolveSttEngine,
  sttEngineIds,
  transcribe,
  type SttContext,
} from "../src/services/transcribe.js";
import { VOICE_SETTINGS_DEFAULTS, type VoiceSettings } from "../src/services/voice.js";

function voiceSettings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return { ...VOICE_SETTINGS_DEFAULTS, ...overrides };
}

function audio(overrides: Partial<SttContext["audio"]> = {}): SttContext["audio"] {
  return { data: Buffer.from([1, 2, 3, 4]), contentType: "audio/webm", ...overrides };
}

/** Stub global fetch; returns the captured calls and a restore fn. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// registry (same law as the TTS engine registry / harnesses)

test("engines: elevenlabs and openai are registered", () => {
  assert.ok(sttEngineIds().includes("elevenlabs"));
  assert.ok(sttEngineIds().includes("openai"));
});

test("resolveSttEngine picks the engine named by settings.sttEngine", () => {
  assert.equal(resolveSttEngine(voiceSettings({ sttEngine: "openai" })).id, "openai");
  assert.equal(resolveSttEngine(voiceSettings({ sttEngine: "elevenlabs" })).id, "elevenlabs");
});

test("resolveSttEngine throws on an unknown engine id", () => {
  assert.throws(() => resolveSttEngine(voiceSettings({ sttEngine: "nope" })), /Unknown STT engine "nope"/);
});

test("registerSttEngine adds a data-only engine the shared path can resolve", () => {
  registerSttEngine({ id: "test-echo", label: "echo", transcribe: async () => ({ text: "echo" }) });
  assert.ok(findSttEngine("test-echo"));
  assert.equal(resolveSttEngine(voiceSettings({ sttEngine: "test-echo" })).id, "test-echo");
});

// ---------------------------------------------------------------------------
// shared transcribe path

test("transcribe rejects empty audio without hitting an engine", async () => {
  await assert.rejects(
    transcribe({ audio: audio({ data: Buffer.alloc(0) }), settings: voiceSettings() }),
    /No audio to transcribe/,
  );
});

test("transcribe rejects an unknown engine override", async () => {
  await assert.rejects(
    transcribe({ audio: audio(), settings: voiceSettings(), engineId: "ghost" }),
    /Unknown STT engine "ghost"/,
  );
});

test("transcribe trims the transcript and reports the engine used", async () => {
  registerSttEngine({ id: "test-pad", label: "pad", transcribe: async () => ({ text: "  hello world \n" }) });
  const result = await transcribe({ audio: audio(), settings: voiceSettings({ sttEngine: "test-pad" }) });
  assert.deepEqual(result, { text: "hello world", engine: "test-pad" });
});

test("transcribe honors an explicit engine override over the setting", async () => {
  registerSttEngine({ id: "test-override", label: "ov", transcribe: async () => ({ text: "from override" }) });
  const result = await transcribe({ audio: audio(), settings: voiceSettings({ sttEngine: "elevenlabs" }), engineId: "test-override" });
  assert.equal(result.engine, "test-override");
  assert.equal(result.text, "from override");
});

// ---------------------------------------------------------------------------
// elevenlabs — the Scribe API (fetch stubbed; no network)

test("elevenlabs: POSTs a multipart clip with the key + model, returns text", async () => {
  const spec = findSttEngine("elevenlabs");
  if (!spec) throw new Error("elevenlabs not registered");
  const { calls, restore } = stubFetch(() => jsonResponse({ text: "come here" }));
  try {
    const result = await spec.transcribe({
      audio: audio({ contentType: "audio/webm;codecs=opus" }),
      settings: voiceSettings({ elevenLabsApiKey: "sk_test", elevenLabsSttModel: "scribe_v1", sttLanguage: "en" }),
      language: "en",
      log: () => {},
    });
    assert.equal(result.text, "come here");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/v1/speech-to-text"));
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["xi-api-key"], "sk_test");
    // No hand-set content-type: fetch must add the multipart boundary itself.
    assert.equal(headers["content-type"], undefined);
    const body = calls[0].init.body;
    assert.ok(body instanceof FormData, "body is multipart FormData");
    assert.equal(body.get("model_id"), "scribe_v1");
    assert.equal(body.get("language_code"), "en");
    const file = body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal((file as File).name, "dictation.webm");
  } finally {
    restore();
  }
});

test("elevenlabs: surfaces the API error status + detail", async () => {
  const spec = findSttEngine("elevenlabs");
  if (!spec) throw new Error("elevenlabs not registered");
  const { restore } = stubFetch(() => new Response("bad key", { status: 401 }));
  try {
    await assert.rejects(
      spec.transcribe({ audio: audio(), settings: voiceSettings({ elevenLabsApiKey: "x" }), log: () => {} }),
      /ElevenLabs transcription failed \(401\): bad key/,
    );
  } finally {
    restore();
  }
});

test("elevenlabs: missing key is a clear error, not a network call", async () => {
  const spec = findSttEngine("elevenlabs");
  if (!spec) throw new Error("elevenlabs not registered");
  const prev = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    await assert.rejects(
      spec.transcribe({ audio: audio(), settings: voiceSettings({ elevenLabsApiKey: "" }), log: () => {} }),
      /ElevenLabs API key not set/,
    );
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  }
});

// ---------------------------------------------------------------------------
// openai — any OpenAI-compatible endpoint (hosted or local whisper-server)

test("openai: POSTs to <base>/audio/transcriptions with a bearer key + model", async () => {
  const spec = findSttEngine("openai");
  if (!spec) throw new Error("openai not registered");
  const { calls, restore } = stubFetch(() => jsonResponse({ text: "local whisper" }));
  try {
    const result = await spec.transcribe({
      audio: audio({ contentType: "audio/mp4" }),
      settings: voiceSettings({ sttOpenAiApiKey: "sk_oa", sttOpenAiModel: "whisper-1" }),
      log: () => {},
    });
    assert.equal(result.text, "local whisper");
    assert.ok(calls[0].url.endsWith("/v1/audio/transcriptions"));
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer sk_oa");
    const body = calls[0].init.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.get("model"), "whisper-1");
    assert.equal((body.get("file") as File).name, "dictation.mp4");
  } finally {
    restore();
  }
});

test("openai: a localhost base URL needs no key; a remote one does", async () => {
  const spec = findSttEngine("openai");
  if (!spec) throw new Error("openai not registered");
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { calls, restore } = stubFetch(() => jsonResponse({ text: "ok" }));
  try {
    // Local: no key required, no auth header sent.
    await spec.transcribe({
      audio: audio(),
      settings: voiceSettings({ sttOpenAiBaseUrl: "http://127.0.0.1:8080/v1", sttOpenAiApiKey: "" }),
      log: () => {},
    });
    assert.equal((calls[0].init.headers as Record<string, string>)?.authorization, undefined);
    // Remote with no key: rejected before any request.
    await assert.rejects(
      spec.transcribe({
        audio: audio(),
        settings: voiceSettings({ sttOpenAiBaseUrl: "https://api.openai.com/v1", sttOpenAiApiKey: "" }),
        log: () => {},
      }),
      /OpenAI STT API key not set/,
    );
    assert.equal(calls.length, 1, "remote-no-key made no network call");
  } finally {
    restore();
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});
