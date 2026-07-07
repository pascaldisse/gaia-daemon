// ONE voice module (v1 scattered this over voice-stack.ts, voice-bridge.ts,
// voice-settings.ts and the web server's routes):
//   1. settings   — ~/.gaia/voice.json, defaults + runtime-resolved unmute dir
//   2. stack      — on-demand lifecycle for the unmute services (STT/TTS/backend)
//   3. overrides  — DURABLE call-scoped thinking overrides (~/.gaia/voice-state.json):
//                   persisted BEFORE applying, cleared on restore, swept on boot,
//                   so a crash mid-call can never leave a "temporary" override on
//   4. session    — VoiceService: startCall/stopCall/status, single-call invariant
//   5. bridge     — unmute's OpenAI-compatible LLM protocol → GAIA agent turns

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { bundledDir, globalPaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import { json, parseBody } from "../core/http.js";
import { newId } from "../core/ids.js";
import type { UiEvent, VoiceCallInfo } from "../core/types.js";

// ---------------------------------------------------------------------------
// Settings (~/.gaia/voice.json) — a plain JSON file like every other GAIA
// setting, edited through the settings UI (Voice tab) or by hand. Created with
// defaults on first boot so the tab always has something to show; missing or
// invalid keys fall back to defaults.

// The unmute voice stack ships as a git submodule (unmute/, a fork of
// kyutai-labs/unmute, MIT licensed, Copyright 2025 Kyutai), so the default
// checkout is the bundled one. Resolved at runtime (never persisted) so a
// renamed/moved repo can't leave a stale absolute path baked into voice.json.
export function bundledUnmuteDir(): string {
  return bundledDir("unmute");
}

export interface VoiceSettings {
  /** unmute backend the browser connects to (and GAIA health-checks). */
  unmuteUrl: string;
  /** Local unmute checkout used to auto-start services. */
  unmuteDir: string;
  /** Start missing voice services automatically when a call is dialed. */
  autoStart: boolean;
  /** How long the stack may take to become healthy (first start loads models). */
  startTimeoutSec: number;
  /** Whether the agent speaks up on its own after a long user silence. */
  speakOnSilence: boolean;
  /** Seconds of silence before the agent speaks up (when enabled). */
  silenceDelaySec: number;
  /** Force thinking off during voice calls; restored on hang-up. */
  disableThinking: boolean;
  /** Default read-aloud TTS engine for the transcript play button; agents
   * override per-persona via agent.json `tts.engine`. */
  ttsEngine: string;
  /** claude-voice daemon the "claude" read-aloud engine talks to. */
  claudeVoiceUrl: string;
  /** claude-voice checkout to auto-start when its daemon is down ("" = never
   * auto-start; the engine then requires the daemon to already be running). */
  claudeVoiceDir: string;
  /** ElevenLabs API key (xi-api-key) for the "elevenlabs" engine. Empty falls
   * back to the ELEVENLABS_API_KEY env var; the engine errors if neither is set.
   * Held locally in voice.json (this daemon binds to loopback). */
  elevenLabsApiKey: string;
  /** ElevenLabs model for the "elevenlabs" engine. eleven_v3 renders inline
   * audio tags ([moans], [breathy], [laughs], …); flash/turbo trade tags for
   * lower call latency. */
  elevenLabsModel: string;
  /** Default ElevenLabs voice id when an agent sets no tts.voice. */
  elevenLabsVoice: string;
  /** Speech-to-text engine for composer dictation (voice INPUT), by id. Swap it
   * like ttsEngine — the shared transcribe path never branches on the engine.
   * "elevenlabs" (Scribe API) is the default; "openai" hits any
   * OpenAI-compatible /audio/transcriptions endpoint (hosted or a local
   * whisper-server). Live-CALL STT is a separate path (the unmute stack). */
  sttEngine: string;
  /** Optional spoken-language hint for dictation (ISO 639 code); "" auto-detects. */
  sttLanguage: string;
  /** ElevenLabs speech-to-text model for the "elevenlabs" STT engine
   * (scribe_v1). Reuses elevenLabsApiKey / ELEVENLABS_API_KEY. */
  elevenLabsSttModel: string;
  /** Base URL for the "openai" STT engine — default OpenAI, or point it at a
   * local whisper-server ("http://127.0.0.1:8080/v1") to keep dictation
   * fully local. */
  sttOpenAiBaseUrl: string;
  /** API key for the "openai" STT engine. Empty falls back to OPENAI_API_KEY;
   * a localhost base URL may need no key at all. */
  sttOpenAiApiKey: string;
  /** Model for the "openai" STT engine (whisper-1, or a local model name). */
  sttOpenAiModel: string;
}

export const VOICE_SETTINGS_DEFAULTS: VoiceSettings = {
  unmuteUrl: "ws://127.0.0.1:8000",
  // Empty = use the bundled checkout, resolved at runtime by readVoiceSettings.
  // Never seed an absolute path here: it would go stale if the repo is moved.
  unmuteDir: "",
  autoStart: true,
  startTimeoutSec: 180,
  speakOnSilence: true,
  silenceDelaySec: 7,
  disableThinking: true,
  ttsEngine: "kyutai",
  claudeVoiceUrl: "http://127.0.0.1:8778",
  claudeVoiceDir: "",
  elevenLabsApiKey: "",
  elevenLabsModel: "eleven_v3",
  // Premade "Rachel" — a neutral default; agents set their own tts.voice.
  elevenLabsVoice: "21m00Tcm4TlvDq8ikWAM",
  // API-based STT is the default: local models are unreliable under memory
  // pressure (why the user asked for this), and elevenlabs reuses the key the
  // TTS engine already has.
  sttEngine: "elevenlabs",
  sttLanguage: "",
  elevenLabsSttModel: "scribe_v1",
  sttOpenAiBaseUrl: "https://api.openai.com/v1",
  sttOpenAiApiKey: "",
  sttOpenAiModel: "whisper-1",
};

/** The ElevenLabs API key (xi-api-key), shared by the TTS and STT engines:
 * voice.json `elevenLabsApiKey` first, else the ELEVENLABS_API_KEY env var.
 * Throws when neither is set (both engines need it). */
export function elevenLabsKey(settings: VoiceSettings): string {
  const key = settings.elevenLabsApiKey?.trim() || process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ElevenLabs API key not set (voice.json elevenLabsApiKey or ELEVENLABS_API_KEY env)");
  return key;
}

export async function ensureVoiceSettingsFile(): Promise<void> {
  const path = globalPaths.voiceSettings();
  if (existsSync(path)) return;
  await writeJsonAtomic(path, VOICE_SETTINGS_DEFAULTS);
}

export async function readVoiceSettings(): Promise<VoiceSettings> {
  const settings = { ...VOICE_SETTINGS_DEFAULTS };
  // Missing or malformed file: defaults apply.
  const raw = ((await readJson(globalPaths.voiceSettings())) ?? {}) as Record<string, unknown>;
  if (typeof raw.unmuteUrl === "string" && raw.unmuteUrl) settings.unmuteUrl = raw.unmuteUrl;
  if (typeof raw.unmuteDir === "string" && raw.unmuteDir) settings.unmuteDir = raw.unmuteDir;
  if (typeof raw.autoStart === "boolean") settings.autoStart = raw.autoStart;
  if (typeof raw.startTimeoutSec === "number" && raw.startTimeoutSec > 0) settings.startTimeoutSec = raw.startTimeoutSec;
  if (typeof raw.speakOnSilence === "boolean") settings.speakOnSilence = raw.speakOnSilence;
  if (typeof raw.silenceDelaySec === "number" && raw.silenceDelaySec > 0) settings.silenceDelaySec = raw.silenceDelaySec;
  if (typeof raw.disableThinking === "boolean") settings.disableThinking = raw.disableThinking;
  if (typeof raw.ttsEngine === "string" && raw.ttsEngine.trim()) settings.ttsEngine = raw.ttsEngine.trim();
  if (typeof raw.claudeVoiceUrl === "string" && raw.claudeVoiceUrl.trim()) settings.claudeVoiceUrl = raw.claudeVoiceUrl.trim();
  if (typeof raw.claudeVoiceDir === "string" && raw.claudeVoiceDir.trim()) settings.claudeVoiceDir = raw.claudeVoiceDir.trim();
  if (typeof raw.elevenLabsApiKey === "string" && raw.elevenLabsApiKey.trim()) settings.elevenLabsApiKey = raw.elevenLabsApiKey.trim();
  if (typeof raw.elevenLabsModel === "string" && raw.elevenLabsModel.trim()) settings.elevenLabsModel = raw.elevenLabsModel.trim();
  if (typeof raw.elevenLabsVoice === "string" && raw.elevenLabsVoice.trim()) settings.elevenLabsVoice = raw.elevenLabsVoice.trim();
  if (typeof raw.sttEngine === "string" && raw.sttEngine.trim()) settings.sttEngine = raw.sttEngine.trim();
  // Language is intentionally allowed to be "" (auto-detect), so accept any string.
  if (typeof raw.sttLanguage === "string") settings.sttLanguage = raw.sttLanguage.trim();
  if (typeof raw.elevenLabsSttModel === "string" && raw.elevenLabsSttModel.trim()) settings.elevenLabsSttModel = raw.elevenLabsSttModel.trim();
  if (typeof raw.sttOpenAiBaseUrl === "string" && raw.sttOpenAiBaseUrl.trim()) settings.sttOpenAiBaseUrl = raw.sttOpenAiBaseUrl.trim();
  if (typeof raw.sttOpenAiApiKey === "string" && raw.sttOpenAiApiKey.trim()) settings.sttOpenAiApiKey = raw.sttOpenAiApiKey.trim();
  if (typeof raw.sttOpenAiModel === "string" && raw.sttOpenAiModel.trim()) settings.sttOpenAiModel = raw.sttOpenAiModel.trim();
  // No explicit override → resolve the bundled checkout now, so the path tracks
  // wherever the daemon currently runs from instead of a value frozen at seed time.
  if (!settings.unmuteDir) settings.unmuteDir = bundledUnmuteDir();
  return settings;
}

// ---------------------------------------------------------------------------
// Stack lifecycle. The user never starts anything by hand: dialing a call
// spawns whatever is not already running (pointed at GAIA as the LLM), waits
// until the unmute backend reports healthy, and hanging up stops the services
// GAIA spawned. Each port is probed for the actual service (not just a
// listener): a real unmute service gets reused, a foreign process on the port
// makes GAIA pick a free port instead, and externally started services are
// never killed.

export interface VoiceStackSettings {
  unmuteDir: string;
  unmuteUrl: string;
  autoStart: boolean;
  startTimeoutMs: number;
  // Seconds before unmute nudges the agent to fill a silence; null disables
  // the nudges entirely (the backend gets an effectively-infinite timeout).
  silenceTimeoutSec?: number | null;
  // An already-running TTS server (ws://…) to point unmute at instead of
  // spawning the bundled moshi service — the gaia TTS bridge uses this to route
  // a call through a read-aloud engine (e.g. claude-voice). When set, the stack
  // never resolves or spawns its own tts service.
  ttsEndpoint?: string;
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
    const response = await fetch(`${backendHttpUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return (await response.json()) as VoiceHealth;
  } catch {
    return null;
  }
}

async function defaultProbeHttpOk(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
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
      throw new Error(`unmute checkout not found at ${settings.unmuteDir} (set voice.unmuteDir in ~/.gaia/voice.json)`);
    }

    mkdirSync(this.logDir, { recursive: true });
    // The services probe independently; resolving them in parallel keeps the
    // worst case at one probe round. An external TTS server (the gaia bridge,
    // e.g. claude-voice) replaces the bundled moshi service entirely: we neither
    // resolve nor spawn a tts child, and point the backend straight at it.
    const externalTts = settings.ttsEndpoint?.trim();
    const [stt, tts, backend] = await Promise.all([
      this.resolveService("stt", STT_PORT, onStatus),
      externalTts ? Promise.resolve(null) : this.resolveService("tts", TTS_PORT, onStatus),
      this.resolveService("backend", configuredBackendPort(settings.unmuteUrl), onStatus),
    ]);
    const ttsUrl = externalTts ?? `ws://localhost:${tts!.port}`;

    const specs: ServiceSpec[] = [
      { name: "stt", script: "macos/start_stt_metal.sh", port: stt.port, env: { STT_PORT: String(stt.port) } },
      ...(tts ? [{ name: "tts", script: "macos/start_tts_mlx.sh", port: tts.port, env: { TTS_MLX_PORT: String(tts.port) } }] : []),
      {
        name: "backend",
        script: "macos/start_backend.sh",
        port: backend.port,
        env: {
          KYUTAI_LLM_URL: gaiaUrl,
          KYUTAI_LLM_MODEL: "gaia",
          KYUTAI_STT_URL: `ws://localhost:${stt.port}`,
          KYUTAI_TTS_URL: ttsUrl,
          KYUTAI_BACKEND_PORT: String(backend.port),
          KYUTAI_USER_SILENCE_TIMEOUT: String(settings.silenceTimeoutSec ?? 1_000_000_000),
        },
      },
    ];
    const needsSpawn: Record<string, boolean> = { stt: stt.spawn, backend: backend.spawn, ...(tts ? { tts: tts.spawn } : {}) };
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

  /**
   * Read-aloud path: makes sure just the TTS service is reachable (reusing a
   * live one — ours or external — or spawning it), and returns its HTTP base
   * URL. The spawned child joins `children`, so a later full-stack call reuses
   * it and hang-up/exit cleanup applies uniformly.
   */
  async ensureTts(settings: VoiceStackSettings, onStatus: (message: string) => void): Promise<{ ttsUrl: string }> {
    const tts = await this.resolveService("tts", TTS_PORT, onStatus);
    const ttsUrl = `http://127.0.0.1:${tts.port}`;
    if (tts.spawn) {
      if (!settings.autoStart) throw new Error("TTS service is not running and voice auto-start is disabled");
      if (!existsSync(join(settings.unmuteDir, "macos"))) {
        throw new Error(`unmute checkout not found at ${settings.unmuteDir} (set voice.unmuteDir in ~/.gaia/voice.json)`);
      }
      mkdirSync(this.logDir, { recursive: true });
      const spawnService = this.hooks.spawnService ?? defaultSpawnService;
      onStatus("voice: starting tts...");
      const spec: ServiceSpec = { name: "tts", script: "macos/start_tts_mlx.sh", port: tts.port, env: { TTS_MLX_PORT: String(tts.port) } };
      this.children.set("tts", { handle: spawnService(spec, settings.unmuteDir, join(this.logDir, "tts.log")), port: tts.port });
      this.installExitHooks();
    }

    const probeHttpOk = this.hooks.probeHttpOk ?? defaultProbeHttpOk;
    const interval = this.hooks.pollIntervalMs ?? 1500;
    const deadline = Date.now() + settings.startTimeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const child = this.children.get("tts");
      if (child?.handle.exited) {
        this.children.delete("tts");
        throw new Error(`voice service tts exited during startup - see ${join(this.logDir, "tts.log")}`);
      }
      if (await probeHttpOk(`${ttsUrl}${CHECK_PATHS.tts}`)) return { ttsUrl };
      if (!announced) {
        announced = true;
        onStatus("voice: waiting for tts... (first start loads models)");
      }
      await sleep(interval);
    }
    throw new Error(`TTS service did not become healthy within ${Math.round(settings.startTimeoutMs / 1000)}s - logs in ${this.logDir}`);
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

// ---------------------------------------------------------------------------
// Durable call overrides (~/.gaia/voice-state.json). A call-scoped change
// (thinking forced off for latency) is recorded HERE, atomically, BEFORE it is
// applied anywhere — so the invariant is: if an override is in effect, the
// record exists. Restore clears the record; boot sweeps and restores any
// orphan a crash mid-call left behind. This closes v1's leaked-override gap
// by protocol, not by care (DESIGN.md §durability).

export interface VoiceCallOverride {
  agentId: string;
  /** The agent's thinking level before the call ("" = unset). */
  previousThinking: string;
}

function overrideFrom(raw: unknown): VoiceCallOverride | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  return { agentId: value.agentId, previousThinking: typeof value.previousThinking === "string" ? value.previousThinking : "" };
}

/** Record a live call override durably. MUST be awaited before applying it. */
export async function persistCallOverride(override: VoiceCallOverride): Promise<void> {
  await writeJsonAtomic(globalPaths.voiceState(), override);
}

/** Clear the override record after the override is restored (hang-up). */
export async function clearCallOverride(): Promise<void> {
  await writeJsonAtomic(globalPaths.voiceState(), {});
}

/** The currently recorded override, if any (exposed for boot logging/tests). */
export async function readCallOverride(): Promise<VoiceCallOverride | undefined> {
  return overrideFrom(await readJson(globalPaths.voiceState()));
}

/**
 * Boot sweep: if a prior process died mid-call, restore the recorded override
 * through the injected setter and clear the record. If restoring fails the
 * record is kept, so the next boot retries — the override can never silently
 * become permanent.
 */
export async function sweepOrphanOverrides(restore: (agentId: string, level: string) => Promise<void>): Promise<void> {
  const orphan = await readCallOverride();
  if (!orphan) return;
  await restore(orphan.agentId, orphan.previousThinking);
  await clearCallOverride();
}

// ---------------------------------------------------------------------------
// Call session. One voice call at a time; unmute's chat-completions requests
// bind to it. Dialing boots the stack (with progress to the UI), hang-up stops
// the services GAIA spawned and restores any call-scoped override.

export interface ActiveVoiceCall {
  workspaceId: string;
  info: VoiceCallInfo;
  settings: VoiceSettings;
}

export interface VoiceStartOptions {
  workspaceId: string;
  roomId: string;
  agent: { id: string; voice?: string; thinking?: string };
  /** GAIA base URL the unmute backend calls back into (KYUTAI_LLM_URL). */
  gaiaUrl: string;
  /** UI event sink (the daemon broadcast). */
  emit: (event: UiEvent) => void;
}

export class VoiceService {
  private readonly stack: VoiceStackManager;
  private call: ActiveVoiceCall | undefined;
  private starting = false;
  private emitToCall: ((event: UiEvent) => void) | undefined;

  constructor(hooks: VoiceStackHooks = {}, logDir = globalPaths.voiceLogsDir()) {
    this.stack = new VoiceStackManager(logDir, hooks);
  }

  get activeCall(): ActiveVoiceCall | undefined {
    return this.call;
  }

  /** The call info a workspace's clients should see (null when none/foreign). */
  status(workspaceId: string | undefined): VoiceCallInfo | null {
    if (!workspaceId || !this.call || this.call.workspaceId !== workspaceId) return null;
    return this.call.info;
  }

  /** Dial: boot the stack, record the durable override, bind the call. Throws
   * on conflict (already active / already starting) and on stack failures. */
  async startCall(options: VoiceStartOptions): Promise<VoiceCallInfo> {
    if (this.call || this.starting) {
      throw new Error(this.call ? `Voice call already active with @${this.call.info.agentId}` : "A voice call is already starting");
    }

    const settings = await readVoiceSettings();
    const stackSettings: VoiceStackSettings = {
      unmuteUrl: settings.unmuteUrl,
      unmuteDir: settings.unmuteDir,
      autoStart: settings.autoStart,
      startTimeoutMs: settings.startTimeoutSec * 1000,
      silenceTimeoutSec: settings.speakOnSilence ? settings.silenceDelaySec : null,
    };

    this.starting = true;
    let unmuteUrl: string;
    try {
      ({ unmuteUrl } = await this.stack.ensureRunning(stackSettings, options.gaiaUrl, (message) => {
        options.emit({
          type: "voice-status",
          workspaceId: options.workspaceId,
          roomId: options.roomId,
          voice: null,
          pending: { agentId: options.agent.id, message },
        });
      }));
    } finally {
      this.starting = false;
    }

    // Voice latency: thinking defaults to off during the call and the agent's
    // configured level returns on hang-up. The override record lands durably
    // BEFORE the call carries the change, so a crash can always restore it.
    if (settings.disableThinking) {
      await persistCallOverride({ agentId: options.agent.id, previousThinking: options.agent.thinking ?? "" });
    }

    const info: VoiceCallInfo = {
      agentId: options.agent.id,
      roomId: options.roomId,
      unmuteUrl,
      ...(options.agent.voice ? { voice: options.agent.voice } : {}),
      ...(settings.disableThinking ? { thinking: "off" } : {}),
      startedAt: new Date().toISOString(),
    };
    this.call = { workspaceId: options.workspaceId, info, settings };
    this.emitToCall = options.emit;
    options.emit({ type: "voice-status", workspaceId: options.workspaceId, roomId: options.roomId, voice: info });
    return info;
  }

  /** Hang up: unbind the call, restore (clear) the override record, and stop
   * exactly the services GAIA spawned (external ones are left alone). */
  async stopCall(workspaceId: string): Promise<void> {
    if (this.call && this.call.workspaceId === workspaceId) {
      const ended = this.call;
      this.call = undefined;
      this.emitToCall?.({ type: "voice-status", workspaceId, roomId: ended.info.roomId, voice: null });
      this.emitToCall = undefined;
      // The thinking override was call-scoped (per-turn); dropping the call IS
      // the restore, so the durable record clears with it.
      await clearCallOverride();
    }
    this.stack.stop();
  }

  /**
   * Call-scoped thinking change: during a live call with `agentId` the level
   * applies to the call only and reverts on hang-up. Returns the user-facing
   * message, or undefined when there is no matching call (the caller should
   * then persist to agent.json instead).
   */
  setCallThinking(workspaceId: string, agentId: string, level: string): string | undefined {
    const call = this.call;
    if (!call || call.workspaceId !== workspaceId || call.info.agentId !== agentId) return undefined;
    if (level === "") delete call.info.thinking;
    else call.info.thinking = level;
    this.emitToCall?.({ type: "voice-status", workspaceId, roomId: call.info.roomId, voice: call.info });
    return `Set @${agentId} thinking to ${level || "agent default"} for this call. It reverts on hang-up.`;
  }
}

// ---------------------------------------------------------------------------
// Bridge: unmute's LLM protocol onto GAIA agent turns. unmute treats GAIA as
// an OpenAI-compatible chat-completions server: each voice turn arrives as the
// last user message of a /v1/chat/completions request. GAIA ignores unmute's
// own system prompt and history - the room transcript and the agent's session
// are the source of truth - and only extracts what the user just said.

// Markers unmute inserts into its chat history (see unmute/llm/llm_utils.py).
const UNMUTE_GREETING_MESSAGE = "Hello.";
const UNMUTE_SILENCE_MARKER = "...";

export type VoiceTurnKind = "greeting" | "silence" | "user";

export interface VoiceTurn {
  kind: VoiceTurnKind;
  // The message to run the agent turn with (what the user said, or a
  // synthetic prompt for greeting/silence turns).
  agentMessage: string;
}

interface BridgeChatMessage {
  role: string;
  content: string;
}

function chatMessages(body: unknown): BridgeChatMessage[] {
  if (!body || typeof body !== "object") return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is BridgeChatMessage =>
      Boolean(message) &&
      typeof message === "object" &&
      typeof (message as BridgeChatMessage).role === "string" &&
      typeof (message as BridgeChatMessage).content === "string",
  );
}

export function isStreamingRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as { stream?: unknown }).stream === true;
}

/**
 * Classifies the newest user message of an unmute chat-completions request.
 * unmute opens every call with a synthetic "Hello." user turn (the agent
 * greets first) and inserts "..." when the user has been silent for a while;
 * neither is something the user said, so they become prompts to the agent
 * rather than room transcript entries.
 */
export function classifyVoiceTurn(body: unknown): VoiceTurn | undefined {
  const messages = chatMessages(body);
  const userMessages = messages.filter((message) => message.role === "user");
  const last = userMessages.at(-1);
  if (!last) return undefined;

  const content = last.content.trim();
  if (content === UNMUTE_GREETING_MESSAGE && userMessages.length === 1) {
    return {
      kind: "greeting",
      agentMessage: "(A voice call with you just started. Greet the user briefly in your own voice and invite them to talk.)",
    };
  }
  if (content === UNMUTE_SILENCE_MARKER) {
    return {
      kind: "silence",
      agentMessage: "(The user on the voice call has been silent for a while. Briefly check in, pick the conversation back up, or comfortably let the silence be - vary it.)",
    };
  }
  return { kind: "user", agentMessage: content };
}

const COMPLETION_MODEL = "gaia";

export function modelListPayload(): unknown {
  // unmute autoselects its model from this list when KYUTAI_LLM_MODEL is not
  // set; it requires exactly one entry.
  return { object: "list", data: [{ id: COMPLETION_MODEL, object: "model", created: 0, owned_by: "gaia" }] };
}

export function completionChunk(id: string, delta: string | undefined, finishReason: "stop" | null): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: COMPLETION_MODEL,
    choices: [
      {
        index: 0,
        delta: delta !== undefined ? { role: "assistant", content: delta } : {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function completionDone(): string {
  return "data: [DONE]\n\n";
}

export function completionPayload(id: string, text: string): unknown {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: COMPLETION_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

export function newCompletionId(): string {
  return newId("chatcmpl");
}

// --- the chat-completions endpoint (KYUTAI_LLM_URL points here) ---------------

/** What the bridge needs from the room service bound to the active call —
 * RoomService satisfies this structurally. */
export interface VoiceTurnRoom {
  waitForIdle(timeoutMs?: number): Promise<void>;
  sendMessage(
    text: string,
    options: { targets: string[]; channel: "voice"; recordUserMessage: boolean; thinking?: string },
  ): Promise<{ id: string }>;
  subscribe(listener: (event: UiEvent) => void): () => void;
  readonly activeTaskId: string | undefined;
  cancelActiveTask(): Promise<unknown>;
}

/** Narrow deps for the OpenAI-compatible voice endpoints. */
export interface VoiceBridgeDeps {
  /** The live call chat-completions requests bind to (undefined → 503). */
  activeCall: ActiveVoiceCall | undefined;
  /** Resolve the room service for the active call's room. */
  roomForCall(call: ActiveVoiceCall): Promise<VoiceTurnRoom>;
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function endCompletionStream(response: ServerResponse, completionId: string): void {
  response.write(completionChunk(completionId, undefined, "stop"));
  response.write(completionDone());
  response.end();
}

/** GET /v1/models — unmute autoselects its model from this single entry. */
export function handleModels(_request: IncomingMessage, response: ServerResponse): void {
  json(response, 200, modelListPayload());
}

/**
 * POST /v1/chat/completions. Each voice turn arrives here; the reply streams
 * back to TTS while the same turn flows through the room service into the
 * transcript and SSE. Self-contained: errors answer as OpenAI error payloads.
 */
export async function handleChatCompletions(request: IncomingMessage, response: ServerResponse, deps: VoiceBridgeDeps): Promise<void> {
  try {
    const call = deps.activeCall;
    if (!call) {
      json(response, 503, { error: { message: "No active GAIA voice call. Start one from the GAIA web UI.", type: "unavailable" } });
      return;
    }

    const body = await parseBody(request);
    const turn = classifyVoiceTurn(body);
    if (!turn) {
      json(response, 400, { error: { message: "Request contains no user message", type: "invalid_request_error" } });
      return;
    }

    const completionId = newCompletionId();
    const streaming = isStreamingRequest(body);

    // Silence nudges disabled: answer with an empty completion so the agent
    // stays quiet instead of speaking up on its own.
    if (turn.kind === "silence" && !call.settings.speakOnSilence) {
      if (streaming) {
        beginSse(response);
        endCompletionStream(response, completionId);
        return;
      }
      json(response, 200, completionPayload(completionId, ""));
      return;
    }

    const room = await deps.roomForCall(call);
    // A typed text task may be running when a voice turn arrives; give it a
    // moment to finish instead of failing the spoken turn outright.
    await room.waitForIdle(20000);

    const task = await room.sendMessage(turn.agentMessage, {
      targets: [call.info.agentId],
      channel: "voice",
      recordUserMessage: turn.kind === "user",
      thinking: call.info.thinking,
    });
    if (streaming) beginSse(response);

    let reply = "";
    let settled = false;
    await new Promise<void>((resolveTurn) => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolveTurn();
      };
      const unsubscribe = room.subscribe((event) => {
        if (event.type === "text-delta" && event.taskId === task.id) {
          reply += event.delta;
          if (streaming) response.write(completionChunk(completionId, event.delta, null));
        }
        if ((event.type === "task-end" || event.type === "task-error") && event.task.id === task.id) finish();
      });
      // unmute aborts the request when the user interrupts the agent.
      response.on("close", () => {
        if (settled) return;
        if (room.activeTaskId === task.id) void room.cancelActiveTask().catch(() => {});
        finish();
      });
    });

    if (response.writableEnded) return;
    if (streaming) {
      endCompletionStream(response, completionId);
      return;
    }
    json(response, 200, completionPayload(completionId, reply));
  } catch (error) {
    if (!response.headersSent) {
      json(response, 500, { error: { message: error instanceof Error ? error.message : String(error), type: "server_error" } });
    } else {
      response.end();
    }
  }
}
