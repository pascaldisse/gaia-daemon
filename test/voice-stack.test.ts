import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { VoiceStackManager, wsToHttp, type SpawnedService, type VoiceHealth, type VoiceStackSettings } from "../src/app/voice-stack.ts";
import { createTempDir } from "./helpers/temp.ts";

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

test("does nothing when the unmute backend is already healthy", async () => {
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

test("refuses to auto-start when disabled or remote", async () => {
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

test("spawns only missing services and waits until healthy, then stop() kills them", async () => {
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

test("falls back to a free port when a foreign process occupies the backend port", async () => {
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

    const result = await manager.ensureRunning(settings({ unmuteDir: unmute.path, silenceTimeoutSec: null }), "http://127.0.0.1:8787", (message) => statuses.push(message));

    assert.equal(result.unmuteUrl, "ws://127.0.0.1:49152");
    assert.equal(spawned.get("backend")?.port, 49152);
    assert.equal(spawned.get("backend")?.env.KYUTAI_USER_SILENCE_TIMEOUT, "1000000000");
    assert.ok(statuses.some((status) => status.includes("port 8000 is taken")));
  } finally {
    await unmute.cleanup();
    await temp.cleanup();
  }
});

test("fails fast and cleans up when a spawned service dies during startup", async () => {
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

test("times out with a pointer to the logs", async () => {
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
