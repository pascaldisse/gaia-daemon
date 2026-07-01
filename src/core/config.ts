// Every value a fresh install falls back to, in one place, plus the parser
// for .gaia/config.json. Anything env-overridable is a function.

import type { SandboxConfig, WorkspaceConfig } from "./types.js";
import { env } from "./env.js";

export const DEFAULTS = {
  harness: "pi",
  model: { provider: "deepseek", name: "deepseek-v4-pro" },
  defaultAgent: "gaia",
  room: "default",
  thinking: "medium",
  transcriptWindow: 20,
  maxSummonsPerRoom: 8,
  host: "127.0.0.1",
  port: 8787,
} as const;

export function gaiaHost(): string {
  return env("GAIA_HOST") ?? DEFAULTS.host;
}

/** GAIA_PORT overrides (0 = pick a free port). */
export function gaiaPort(): number {
  const raw = env("GAIA_PORT");
  if (!raw) return DEFAULTS.port;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULTS.port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseSandboxConfig(raw: unknown): SandboxConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const config: SandboxConfig = {};
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (typeof raw.backend === "string" && raw.backend.trim()) config.backend = raw.backend.trim();
  if (Array.isArray(raw.writable)) config.writable = raw.writable.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  if (raw.net === "full" || raw.net === "none") config.net = raw.net;
  if (typeof raw.credentialProxy === "boolean") config.credentialProxy = raw.credentialProxy;
  return Object.keys(config).length > 0 ? config : undefined;
}

/** Parse a raw config.json value over the defaults. Unknown/bad fields drop. */
export function parseWorkspaceConfig(raw: unknown, validHarness: (id: string) => boolean): WorkspaceConfig {
  const obj = isRecord(raw) ? raw : {};
  const config: WorkspaceConfig = {
    defaultAgent: typeof obj.defaultAgent === "string" && obj.defaultAgent.trim() ? obj.defaultAgent.trim() : DEFAULTS.defaultAgent,
    room: typeof obj.room === "string" && obj.room.trim() ? obj.room.trim() : DEFAULTS.room,
    transcriptWindow:
      typeof obj.transcriptWindow === "number" && Number.isInteger(obj.transcriptWindow) && obj.transcriptWindow > 0
        ? obj.transcriptWindow
        : DEFAULTS.transcriptWindow,
  };
  if (typeof obj.harness === "string" && validHarness(obj.harness)) config.harness = obj.harness;
  if (typeof obj.maxSummonsPerRoom === "number" && Number.isInteger(obj.maxSummonsPerRoom) && obj.maxSummonsPerRoom > 0) {
    config.maxSummonsPerRoom = obj.maxSummonsPerRoom;
  }
  const sandbox = parseSandboxConfig(obj.sandbox);
  if (sandbox) config.sandbox = sandbox;
  return config;
}
