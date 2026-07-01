import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { UiEvent } from "../src2/core/types.js";
import {
  VOICE_SETTINGS_DEFAULTS,
  VoiceService,
  VoiceStackManager,
  bundledUnmuteDir,
  classifyVoiceTurn,
  clearCallOverride,
  completionChunk,
  completionDone,
  completionPayload,
  ensureVoiceSettingsFile,
  handleChatCompletions,
  isStreamingRequest,
  modelListPayload,
  persistCallOverride,
  readCallOverride,
  readVoiceSettings,
  sweepOrphanOverrides,
  wsToHttp,
  type ActiveVoiceCall,
  type SpawnedService,
  type VoiceHealth,
  type VoiceStackSettings,
} from "../src2/services/voice.js";
import { createTempDir } from "./helpers/temp.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const temp = await createTempDir("gaia-home-");
  const prev = process.env.GAIA_HOME;
  process.env.GAIA_HOME = temp.path;
  try {
    return await fn(temp.path);
  } finally {
    if (prev === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prev;
    await temp.cleanup();
  }
}

// ---------------------------------------------------------------------------
// stack lifecycle

function settings(overrides: Partial<VoiceStackSettings> = {}): VoiceStackSettings {
  return {
    unmuteDir: "/tmp/does-not-matter",
    unmuteUrl: "ws://127.0.0.1:8000",
    autoStart: true,
    startTimeoutMs: 2000,
    ...overrides,
  };
}

class FakeService implements SpawnedService {
  pid = 123;
  exited = false;
  killed = false;
  kill(): void {
    this.killed = true;
    this.exited = true;
  }
  onExit(): void {}
}

async function unmuteCheckout() {
  const dir = await createTempDir();
  await mkdir(join(dir.path, "macos"), { recursive: true });
  return dir;
}

test("stack: does nothing when the unmute backend is already healthy", async () => {
  const temp = await createTempDir();
  try {
    const spawned: string[] = [];
    const manager = new VoiceStackManager(temp.path, {
      probeHealth: async () => ({ ok: true }),
      probePort: async () => true,
      probeHttpOk: async () => true,
      spawnService: (spec) => {
        spawned.push(spec.name);
        return new FakeService();
      },
    });
    const result = await manager.ensureRunning(settings(), "http://127.0.0.1:8787", () => {});
    assert.deepEqual(spawned, []);
    assert.equal(result.unmuteUrl, "ws://127.0.0.1:8000");
  } finally {
    await temp.cleanup();
  }
});

test("stack: refuses to auto-start when disabled or remote", async () => {
  const temp = await createTempDir();
  try {
    const manager = new VoiceStackManager(temp.path, { probeHealth: async () => null });
    await assert.rejects(() => manager.ensureRunning(settings({ autoStart: false }), "http://127.0.0.1:8787", () => {}), /auto-start is disabled/);
    await assert.rejects(
      () => manager.ensureRunning(settings({ unmuteUrl: "ws://voicebox.local:8000" }), "http://127.0.0.1:8787", () => {}),
      /only supported for local backends/,
    );
  } finally {
    await temp.cleanup();
  }
});

test("stack: spawns only missing services and waits until healthy, then stop() kills them", async () => {
  const temp = await createTempDir();
  const unmute = await unmuteCheckout();
  try {
    // Probe 1: ensureRunning's initial check; probe 2: first wait iteration
    // (still booting); probe 3: healthy.
    let healthyAfter = 3;
    const spawned = new Map<string, FakeService>();
    const statuses: string[] = [];
    const manager = new VoiceStackManager(temp.path, {
      probeHealth: async (): Promise<VoiceHealth | null> => {
        healthyAfter -= 1;
        return healthyAfter <= 0 ? { ok: true } : { ok: false, stt_up: true, tts_up: false, llm_up: true };
      },
      // STT (8090) already runs externally and answers its check path;
      // TTS and backend ports are closed.
      probePort: async (port) => port === 8090,
      probeHttpOk: async (url) => url.includes(":8090"),
      spawnService: (spec) => {
        const service = new FakeService();
        spawned.set(spec.name, service);
        if (spec.name === "backend") {
          assert.equal(spec.env.KYUTAI_LLM_URL, "http://127.0.0.1:8787");
          assert.equal(spec.env.KYUTAI_LLM_MODEL, "gaia");
          assert.equal(spec.env.KYUTAI_STT_URL, "ws://localhost:8090");
          assert.equal(spec.env.KYUTAI_USER_SILENCE_TIMEOUT, "9");
        }
        return service;
      },
      pollIntervalMs: 10,
    });

    const result = await manager.ensureRunning(
      settings({ unmuteDir: unmute.path, silenceTimeoutSec: 9 }),
      "http://127.0.0.1:8787",
      (message) => statuses.push(message),
    );

    assert.deepEqual([...spawned.keys()].sort(), ["backend", "tts"]);
    assert.equal(result.unmuteUrl, "ws://127.0.0.1:8000");
    assert.ok(statuses.some((status) => status.includes("starting tts")));
    assert.ok(statuses.some((status) => status.includes("waiting for tts")));
    assert.equal(statuses.at(-1), "voice: ready");

    manager.stop();
    assert.ok([...spawned.values()].every((service) => service.killed));
    assert.deepEqual(manager.spawnedServices, []);
  } finally {
    await unmute.cleanup();
    await temp.cleanup();
  }
});

test("stack: falls back to a free port when a foreign process occupies the backend port", async () => {
  const temp = await createTempDir();
  const unmute = await unmuteCheckout();
  try {
    let healthy = false;
    const spawned = new Map<string, { port: number; env: Record<string, string> }>();
    const statuses: string[] = [];
    const manager = new VoiceStackManager(temp.path, {
      probeHealth: async () => {
        const result = healthy ? { ok: true } : null;
        healthy = true;
        return result;
      },
      // Port 8000 is open but it is NOT unmute: the check path fails.
      probePort: async (port) => port === 8000,
      probeHttpOk: async () => false,
      freePort: async () => 49152,
      spawnService: (spec) => {
        spawned.set(spec.name, { port: spec.port, env: spec.env });
        return new FakeService();
      },
      pollIntervalMs: 10,
    });

    const result = await manager.ensureRunning(settings({ unmuteDir: unmute.path, silenceTimeoutSec: null }), "http://127.0.0.1:8787", (message) =>
      statuses.push(message),
    );

    assert.equal(result.unmuteUrl, "ws://127.0.0.1:49152");
    assert.equal(spawned.get("backend")?.port, 49152);
    assert.equal(spawned.get("backend")?.env.KYUTAI_USER_SILENCE_TIMEOUT, "1000000000");
    assert.ok(statuses.some((status) => status.includes("port 8000 is taken")));
  } finally {
    await unmute.cleanup();
    await temp.cleanup();
  }
});

test("stack: fails fast and cleans up when a spawned service dies during startup", async () => {
  const temp = await createTempDir();
  const unmute = await unmuteCheckout();
  try {
    const spawned = new Map<string, FakeService>();
    const manager = new VoiceStackManager(temp.path, {
      probeHealth: async () => null,
      probePort: async () => false,
      spawnService: (spec) => {
        const service = new FakeService();
        if (spec.name === "tts") service.exited = true;
        spawned.set(spec.name, service);
        return service;
      },
      pollIntervalMs: 10,
    });

    await assert.rejects(
      () => manager.ensureRunning(settings({ unmuteDir: unmute.path }), "http://127.0.0.1:8787", () => {}),
      /voice service tts exited during startup/,
    );
    assert.ok(spawned.get("backend")?.killed);
    assert.deepEqual(manager.spawnedServices, []);
  } finally {
    await unmute.cleanup();
    await temp.cleanup();
  }
});

test("stack: times out with a pointer to the logs", async () => {
  const temp = await createTempDir();
  const unmute = await unmuteCheckout();
  try {
    const manager = new VoiceStackManager(temp.path, {
      probeHealth: async () => ({ ok: false }),
      probePort: async () => false,
      spawnService: () => new FakeService(),
      pollIntervalMs: 10,
    });

    await assert.rejects(
      () => manager.ensureRunning(settings({ unmuteDir: unmute.path, startTimeoutMs: 100 }), "http://127.0.0.1:8787", () => {}),
      /did not become healthy/,
    );
    assert.deepEqual(manager.spawnedServices, []);
  } finally {
    await unmute.cleanup();
    await temp.cleanup();
  }
});

test("wsToHttp converts websocket urls", () => {
  assert.equal(wsToHttp("ws://127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.equal(wsToHttp("wss://example.com/"), "https://example.com");
});

// ---------------------------------------------------------------------------
// settings

test("settings: defaults apply and the bundled unmute dir resolves at runtime", async () => {
  await withTempHome(async () => {
    const loaded = await readVoiceSettings();
    assert.equal(loaded.unmuteUrl, VOICE_SETTINGS_DEFAULTS.unmuteUrl);
    assert.equal(loaded.autoStart, true);
    assert.equal(loaded.disableThinking, true);
    assert.equal(loaded.unmuteDir, bundledUnmuteDir()); // "" in defaults → resolved live
  });
});

test("settings: ensureVoiceSettingsFile seeds once and readVoiceSettings tolerates junk", async () => {
  await withTempHome(async (home) => {
    await ensureVoiceSettingsFile();
    const { readFile, writeFile } = await import("node:fs/promises");
    const seeded = JSON.parse(await readFile(join(home, "voice.json"), "utf8"));
    assert.equal(seeded.unmuteDir, ""); // never a baked absolute path
    await writeFile(join(home, "voice.json"), JSON.stringify({ startTimeoutSec: -5, silenceDelaySec: "x", speakOnSilence: false }), "utf8");
    const loaded = await readVoiceSettings();
    assert.equal(loaded.startTimeoutSec, VOICE_SETTINGS_DEFAULTS.startTimeoutSec); // invalid → default
    assert.equal(loaded.silenceDelaySec, VOICE_SETTINGS_DEFAULTS.silenceDelaySec);
    assert.equal(loaded.speakOnSilence, false);
  });
});

// ---------------------------------------------------------------------------
// bridge classification + payloads

function request(messages: Array<{ role: string; content: string }>, stream = true): unknown {
  return { model: "gaia", messages, stream, temperature: 0.7 };
}

test("bridge: classifies unmute's synthetic greeting turn", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "unmute system prompt" },
      { role: "user", content: "Hello." },
    ]),
  );
  assert.equal(turn?.kind, "greeting");
  assert.match(turn?.agentMessage ?? "", /voice call/i);
});

test("bridge: a literal 'Hello.' later in the call is a real user turn", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "prompt" },
      { role: "user", content: "Hey there" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "Hello." },
    ]),
  );
  assert.equal(turn?.kind, "user");
});

test("bridge: classifies the silence marker as a nudge, not a user message", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "prompt" },
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "..." },
    ]),
  );
  assert.equal(turn?.kind, "silence");
});

test("bridge: classifies a normal spoken turn", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "prompt" },
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "what files are in this project" },
    ]),
  );
  assert.equal(turn?.kind, "user");
  assert.equal(turn?.agentMessage, "what files are in this project");
});

test("bridge: returns undefined when there is no user message", () => {
  assert.equal(classifyVoiceTurn(request([{ role: "system", content: "prompt" }])), undefined);
  assert.equal(classifyVoiceTurn({}), undefined);
  assert.equal(classifyVoiceTurn(undefined), undefined);
});

test("bridge: detects streaming requests", () => {
  assert.equal(isStreamingRequest(request([], true)), true);
  assert.equal(isStreamingRequest(request([], false)), false);
  assert.equal(isStreamingRequest({}), false);
});

test("bridge: model list payload offers exactly one model for unmute autoselection", () => {
  const payload = modelListPayload() as { object: string; data: Array<{ id: string }> };
  assert.equal(payload.object, "list");
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0]?.id, "gaia");
});

test("bridge: streams OpenAI-compatible chunks", () => {
  const chunk = completionChunk("chatcmpl_x", "hi", null);
  assert.match(chunk, /^data: /);
  assert.match(chunk, /\n\n$/);
  const parsed = JSON.parse(chunk.slice("data: ".length));
  assert.equal(parsed.object, "chat.completion.chunk");
  assert.equal(parsed.choices[0].delta.content, "hi");
  assert.equal(parsed.choices[0].finish_reason, null);

  const finish = JSON.parse(completionChunk("chatcmpl_x", undefined, "stop").slice("data: ".length));
  assert.deepEqual(finish.choices[0].delta, {});
  assert.equal(finish.choices[0].finish_reason, "stop");

  assert.equal(completionDone(), "data: [DONE]\n\n");
});

test("bridge: builds a non-streaming completion payload", () => {
  const payload = completionPayload("chatcmpl_x", "hello there") as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
  };
  assert.equal(payload.choices[0]?.message.content, "hello there");
  assert.equal(payload.choices[0]?.finish_reason, "stop");
});

// ---------------------------------------------------------------------------
// durable call overrides (~/.gaia/voice-state.json)

test("overrides: apply → crash (no restore) → sweepOrphanOverrides restores exactly once", async () => {
  await withTempHome(async () => {
    await persistCallOverride({ agentId: "gaia", previousThinking: "medium" });
    assert.deepEqual(await readCallOverride(), { agentId: "gaia", previousThinking: "medium" });

    const restored: Array<[string, string]> = [];
    await sweepOrphanOverrides(async (agentId, level) => {
      restored.push([agentId, level]);
    });
    assert.deepEqual(restored, [["gaia", "medium"]]);
    assert.equal(await readCallOverride(), undefined);

    // A second sweep finds nothing.
    await sweepOrphanOverrides(async () => {
      throw new Error("should not be called");
    });
  });
});

test("overrides: a clean hang-up clears the record, so the sweep is a no-op", async () => {
  await withTempHome(async () => {
    await persistCallOverride({ agentId: "gaia", previousThinking: "" });
    await clearCallOverride();
    let calls = 0;
    await sweepOrphanOverrides(async () => {
      calls++;
    });
    assert.equal(calls, 0);
  });
});

test("overrides: a failing restore keeps the record for the next boot", async () => {
  await withTempHome(async () => {
    await persistCallOverride({ agentId: "gaia", previousThinking: "high" });
    await assert.rejects(() =>
      sweepOrphanOverrides(async () => {
        throw new Error("agent.json unwritable");
      }),
    );
    assert.deepEqual(await readCallOverride(), { agentId: "gaia", previousThinking: "high" });
  });
});

// ---------------------------------------------------------------------------
// call session (VoiceService)

test("call: startCall records the override durably, binds one call, stopCall restores", async () => {
  await withTempHome(async (home) => {
    const events: UiEvent[] = [];
    const service = new VoiceService({ probeHealth: async () => ({ ok: true }) }, join(home, "logs", "voice"));

    assert.equal(service.status("ws"), null);
    const info = await service.startCall({
      workspaceId: "ws",
      roomId: "default",
      agent: { id: "gaia", voice: "warm", thinking: "medium" },
      gaiaUrl: "http://127.0.0.1:8787",
      emit: (event) => events.push(event),
    });

    assert.equal(info.agentId, "gaia");
    assert.equal(info.unmuteUrl, "ws://127.0.0.1:8000");
    assert.equal(info.thinking, "off"); // disableThinking default forces it off
    assert.equal(info.voice, "warm");
    // The durable record landed BEFORE the call carried the change.
    assert.deepEqual(await readCallOverride(), { agentId: "gaia", previousThinking: "medium" });
    assert.equal(service.status("ws")?.agentId, "gaia");
    assert.equal(service.status("other"), null);
    assert.equal(events.at(-1)?.type, "voice-status");

    // Single-call invariant.
    await assert.rejects(
      () =>
        service.startCall({
          workspaceId: "ws2",
          roomId: "default",
          agent: { id: "terry" },
          gaiaUrl: "http://127.0.0.1:8787",
          emit: () => {},
        }),
      /already active with @gaia/,
    );

    // Call-scoped thinking change (reverts on hang-up), not persisted anywhere.
    const message = service.setCallThinking("ws", "gaia", "high");
    assert.match(message ?? "", /for this call/);
    assert.equal(service.status("ws")?.thinking, "high");
    assert.equal(service.setCallThinking("ws", "terry", "low"), undefined); // not the call agent

    await service.stopCall("ws");
    assert.equal(service.status("ws"), null);
    assert.equal(await readCallOverride(), undefined); // restored + cleared
    const last = events.at(-1);
    assert.ok(last?.type === "voice-status" && last.voice === null);
  });
});

// ---------------------------------------------------------------------------
// chat-completions handler (narrow deps, no real HTTP)

interface WrittenResponse {
  status?: number;
  body: string;
  chunks: string[];
}

function fakeRequest(body: unknown): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; out: WrittenResponse } {
  const out: WrittenResponse = { body: "", chunks: [] };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      out.status = status;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    write(chunk: string) {
      out.chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) out.body += chunk;
      (this as { writableEnded: boolean }).writableEnded = true;
    },
    on() {
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

function callStub(overrides: Partial<ActiveVoiceCall["settings"]> = {}): ActiveVoiceCall {
  return {
    workspaceId: "ws",
    info: { agentId: "gaia", roomId: "default", unmuteUrl: "ws://127.0.0.1:8000", startedAt: "now" },
    settings: { ...VOICE_SETTINGS_DEFAULTS, unmuteDir: "/tmp/x", ...overrides },
  };
}

test("chat-completions: no active call answers 503 without touching the room", async () => {
  const { res, out } = fakeResponse();
  await handleChatCompletions(fakeRequest(request([{ role: "user", content: "hi" }], false)), res, {
    activeCall: undefined,
    roomForCall: () => Promise.reject(new Error("must not be called")),
  });
  assert.equal(out.status, 503);
  assert.match(out.body, /No active GAIA voice call/);
});

test("chat-completions: a silence nudge with speakOnSilence off answers an empty completion", async () => {
  const { res, out } = fakeResponse();
  await handleChatCompletions(
    fakeRequest(request([{ role: "user", content: "Hello." }, { role: "assistant", content: "Hi" }, { role: "user", content: "..." }], false)),
    res,
    {
      activeCall: callStub({ speakOnSilence: false }),
      roomForCall: () => Promise.reject(new Error("must not be called")),
    },
  );
  assert.equal(out.status, 200);
  const payload = JSON.parse(out.body) as { choices: Array<{ message: { content: string } }> };
  assert.equal(payload.choices[0]?.message.content, "");
});

test("chat-completions: a user turn runs through the room and streams deltas back", async () => {
  const { res, out } = fakeResponse();
  let sent: { text: string; targets: string[]; recordUserMessage: boolean } | undefined;
  const listeners: Array<(event: UiEvent) => void> = [];
  const room = {
    waitForIdle: async () => {},
    sendMessage: async (text: string, options: { targets: string[]; channel: "voice"; recordUserMessage: boolean; thinking?: string }) => {
      sent = { text, targets: options.targets, recordUserMessage: options.recordUserMessage };
      // Macrotask: the handler subscribes right after this resolves; the turn's
      // events must land after that registration.
      setTimeout(() => {
        const scope = { workspaceId: "ws", roomId: "default", taskId: "task_1", agentId: "gaia", eventId: "evt_1" };
        for (const listener of listeners) listener({ ...scope, type: "text-delta", delta: "hi there" });
        for (const listener of listeners) {
          listener({
            type: "task-end",
            workspaceId: "ws",
            roomId: "default",
            task: { id: "task_1", roomId: "default", text: "", targets: ["gaia"], status: "complete", startedAt: "now" },
          });
        }
      }, 5);
      return { id: "task_1" };
    },
    subscribe: (listener: (event: UiEvent) => void) => {
      listeners.push(listener);
      return () => {};
    },
    activeTaskId: undefined,
    cancelActiveTask: async () => undefined,
  };
  await handleChatCompletions(
    fakeRequest(request([{ role: "user", content: "Hello." }, { role: "assistant", content: "Hi" }, { role: "user", content: "what's up" }], true)),
    res,
    { activeCall: callStub(), roomForCall: async () => room },
  );
  assert.equal(sent?.text, "what's up");
  assert.deepEqual(sent?.targets, ["gaia"]);
  assert.equal(sent?.recordUserMessage, true);
  assert.equal(out.status, 200);
  assert.ok(out.chunks.some((chunk) => chunk.includes("hi there")));
  assert.equal(out.chunks.at(-1), completionDone());
});
