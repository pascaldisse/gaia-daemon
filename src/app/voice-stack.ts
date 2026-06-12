// On-demand lifecycle for the unmute voice services (STT, TTS, backend).
// The user never starts anything by hand: dialing a call spawns whatever is
// not already running (pointed at GAIA as the LLM), waits until the unmute
// backend reports healthy, and hanging up stops the services GAIA spawned.
// Each port is probed for the actual service (not just a listener): a real
// unmute service gets reused, a foreign process on the port makes GAIA pick
// a free port instead, and externally started services are never killed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

export interface VoiceStackSettings {
  unmuteDir: string;
  unmuteUrl: string;
  autoStart: boolean;
  startTimeoutMs: number;
}

export interface VoiceHealth {
  ok: boolean;
  tts_up?: boolean;
  stt_up?: boolean;
  llm_up?: boolean;
}

interface ServiceSpec {
  name: string;
  script: string;
  port: number;
  env: Record<string, string>;
}

export interface SpawnedService {
  pid: number | undefined;
  exited: boolean;
  kill(): void;
  onExit(listener: () => void): void;
}

export interface VoiceStackHooks {
  probeHealth?: (backendHttpUrl: string) => Promise<VoiceHealth | null>;
  probePort?: (port: number) => Promise<boolean>;
  probeHttpOk?: (url: string) => Promise<boolean>;
  spawnService?: (spec: ServiceSpec, unmuteDir: string, logPath: string) => SpawnedService;
  freePort?: () => Promise<number>;
  pollIntervalMs?: number;
}

const STT_PORT = 8090;
const TTS_PORT = 8089;

// What proves the port is running the expected service rather than an
// unrelated process that happens to listen there.
const CHECK_PATHS: Record<string, string> = {
  stt: "/api/build_info",
  tts: "/api/build_info",
  backend: "/v1/health",
};

export function wsToHttp(url: string): string {
  return url.replace(/^ws/, "http").replace(/\/+$/, "");
}

function configuredBackendPort(unmuteUrl: string): number {
  try {
    return Number(new URL(wsToHttp(unmuteUrl)).port) || 8000;
  } catch {
    return 8000;
  }
}

function isLoopback(unmuteUrl: string): boolean {
  try {
    const host = new URL(wsToHttp(unmuteUrl)).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function defaultProbeHealth(backendHttpUrl: string): Promise<VoiceHealth | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${backendHttpUrl}/v1/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as VoiceHealth;
  } catch {
    return null;
  }
}

async function defaultProbeHttpOk(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function defaultProbePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function defaultFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a free port"))));
    });
    server.once("error", reject);
  });
}

function defaultSpawnService(spec: ServiceSpec, unmuteDir: string, logPath: string): SpawnedService {
  const log = openSync(logPath, "a");
  // Each start script execs its service; detached gives it a process group we
  // can kill as a unit (uv run keeps the actual server as a child).
  const child = spawn(join(unmuteDir, spec.script), [], {
    cwd: unmuteDir,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();

  const handle: SpawnedService = {
    pid: child.pid,
    exited: false,
    kill: () => {
      if (handle.exited || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      }
    },
    onExit: (listener) => child.once("exit", listener),
  };
  child.once("exit", () => {
    handle.exited = true;
  });
  return handle;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type PortState = "service" | "occupied" | "free";

interface ManagedService {
  handle: SpawnedService;
  port: number;
}

export class VoiceStackManager {
  private readonly children = new Map<string, ManagedService>();
  private exitHooksInstalled = false;

  constructor(
    private readonly logDir: string,
    private readonly hooks: VoiceStackHooks = {},
  ) {}

  get spawnedServices(): string[] {
    return [...this.children.keys()];
  }

  /**
   * Makes sure a healthy unmute stack is reachable, starting services as
   * needed, and returns the backend URL the browser should connect to (it
   * can differ from the configured one when a foreign process squats the
   * configured port and GAIA falls back to a free port).
   */
  async ensureRunning(settings: VoiceStackSettings, gaiaUrl: string, onStatus: (message: string) => void): Promise<{ unmuteUrl: string }> {
    const probeHealth = this.hooks.probeHealth ?? defaultProbeHealth;
    if ((await probeHealth(wsToHttp(settings.unmuteUrl)))?.ok) return { unmuteUrl: settings.unmuteUrl };

    if (!settings.autoStart || !isLoopback(settings.unmuteUrl)) {
      throw new Error(
        `unmute backend is not reachable at ${settings.unmuteUrl} and auto-start is ${settings.autoStart ? "only supported for local backends" : "disabled"}`,
      );
    }
    if (!existsSync(join(settings.unmuteDir, "macos"))) {
      throw new Error(`unmute checkout not found at ${settings.unmuteDir} (set voice.unmuteDir in ~/.gaia/app.json)`);
    }

    mkdirSync(this.logDir, { recursive: true });
    const stt = await this.resolveService("stt", STT_PORT, onStatus);
    const tts = await this.resolveService("tts", TTS_PORT, onStatus);
    const backend = await this.resolveService("backend", configuredBackendPort(settings.unmuteUrl), onStatus);

    const specs: ServiceSpec[] = [
      { name: "stt", script: "macos/start_stt_metal.sh", port: stt.port, env: { STT_PORT: String(stt.port) } },
      { name: "tts", script: "macos/start_tts_mlx.sh", port: tts.port, env: { TTS_MLX_PORT: String(tts.port) } },
      {
        name: "backend",
        script: "macos/start_backend.sh",
        port: backend.port,
        env: {
          KYUTAI_LLM_URL: gaiaUrl,
          KYUTAI_LLM_MODEL: "gaia",
          KYUTAI_STT_URL: `ws://localhost:${stt.port}`,
          KYUTAI_TTS_URL: `ws://localhost:${tts.port}`,
          KYUTAI_BACKEND_PORT: String(backend.port),
        },
      },
    ];
    const needsSpawn: Record<string, boolean> = { stt: stt.spawn, tts: tts.spawn, backend: backend.spawn };
    const spawnService = this.hooks.spawnService ?? defaultSpawnService;
    for (const spec of specs) {
      if (!needsSpawn[spec.name]) continue;
      onStatus(`voice: starting ${spec.name}...`);
      const handle = spawnService(spec, settings.unmuteDir, join(this.logDir, `${spec.name}.log`));
      this.children.set(spec.name, { handle, port: spec.port });
    }
    this.installExitHooks();

    const unmuteUrl = `ws://127.0.0.1:${backend.port}`;
    await this.waitForHealthy(settings, wsToHttp(unmuteUrl), onStatus);
    return { unmuteUrl };
  }

  // Hang-up: stop only the services GAIA itself spawned.
  stop(): void {
    for (const [name, service] of this.children) {
      service.handle.kill();
      this.children.delete(name);
    }
  }

  // Decides which port a service should use and whether to spawn it:
  // reuse our own live child, reuse an external instance that answers the
  // service's check path, spawn fresh on a free port, or - when a foreign
  // process holds the port - fall back to an ephemeral port.
  private async resolveService(name: string, preferredPort: number, onStatus: (message: string) => void): Promise<{ port: number; spawn: boolean }> {
    const existing = this.children.get(name);
    if (existing && !existing.handle.exited) return { port: existing.port, spawn: false };
    this.children.delete(name);

    const state = await this.portState(preferredPort, CHECK_PATHS[name] ?? "/");
    if (state === "service") return { port: preferredPort, spawn: false };
    if (state === "free") return { port: preferredPort, spawn: true };

    const freePort = this.hooks.freePort ?? defaultFreePort;
    const fallback = await freePort();
    onStatus(`voice: port ${preferredPort} is taken by another process, using ${fallback} for ${name}`);
    return { port: fallback, spawn: true };
  }

  private async portState(port: number, checkPath: string): Promise<PortState> {
    const probePort = this.hooks.probePort ?? defaultProbePort;
    if (!(await probePort(port))) return "free";
    const probeHttpOk = this.hooks.probeHttpOk ?? defaultProbeHttpOk;
    return (await probeHttpOk(`http://127.0.0.1:${port}${checkPath}`)) ? "service" : "occupied";
  }

  private async waitForHealthy(settings: VoiceStackSettings, backendHttpUrl: string, onStatus: (message: string) => void): Promise<void> {
    const probeHealth = this.hooks.probeHealth ?? defaultProbeHealth;
    const interval = this.hooks.pollIntervalMs ?? 1500;
    const deadline = Date.now() + settings.startTimeoutMs;
    let lastMessage = "";

    while (Date.now() < deadline) {
      for (const [name, service] of this.children) {
        if (service.handle.exited) {
          this.stop();
          throw new Error(`voice service ${name} exited during startup - see ${join(this.logDir, `${name}.log`)}`);
        }
      }

      const health = await probeHealth(backendHttpUrl);
      if (health?.ok) {
        onStatus("voice: ready");
        return;
      }

      const parts: Array<[string, boolean | undefined]> = health ? [["stt", health.stt_up], ["tts", health.tts_up], ["llm", health.llm_up]] : [];
      const waiting = health ? parts.filter(([, up]) => !up).map(([part]) => part).join(", ") : "backend";
      const message = `voice: waiting for ${waiting || "services"}... (first start loads models)`;
      if (message !== lastMessage) {
        lastMessage = message;
        onStatus(message);
      }
      await sleep(interval);
    }

    this.stop();
    throw new Error(`voice stack did not become healthy within ${Math.round(settings.startTimeoutMs / 1000)}s - logs in ${this.logDir}`);
  }

  // GAIA restarts (dev watch sends SIGTERM) and exits must not orphan the
  // services, or hang-up could never stop them again.
  private installExitHooks(): void {
    if (this.exitHooksInstalled) return;
    this.exitHooksInstalled = true;
    process.once("exit", () => this.stop());
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        this.stop();
        process.exit(0);
      });
    }
  }
}
