// Every value a fresh install falls back to, in one place, plus the parser
// for .gaia/config.json. Anything env-overridable is a function.

import type { HookCommand, HooksConfig, McpServerConfig, MemoryConfig, MemoryConfigPatch, SandboxConfig, WorkspaceConfig } from "./types.js";
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

// Memory v3 defaults (MEMORY-DESIGN.md): everything on, embeddings resolved
// from whatever key exists, lexical-only when none does.
export const MEMORY_DEFAULTS: MemoryConfig = {
  autoRecall: true,
  autoRecallBudget: 1_200,
  embeddings: "auto",
  consolidate: { enabled: true, idleMinutes: 30, maxPerDay: 8 },
  decayHalfLifeDays: 60,
};

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

const HOOK_EVENTS = ["preTurn", "postTurn", "toolUse", "error"] as const;

function parseHookList(raw: unknown): HookCommand[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const hooks: HookCommand[] = [];
  for (const entry of raw) {
    // String shorthand or { command, timeoutSec }.
    if (typeof entry === "string" && entry.trim()) {
      hooks.push({ command: entry.trim() });
    } else if (isRecord(entry) && typeof entry.command === "string" && entry.command.trim()) {
      hooks.push({
        command: entry.command.trim(),
        ...(typeof entry.timeoutSec === "number" && entry.timeoutSec > 0 ? { timeoutSec: entry.timeoutSec } : {}),
      });
    }
  }
  return hooks.length > 0 ? hooks : undefined;
}

/** Parse the `hooks` section (config.json). Unknown events/bad entries drop. */
export function parseHooksConfig(raw: unknown): HooksConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const hooks: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    const list = parseHookList(raw[event]);
    if (list) hooks[event] = list;
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/** Parse an `mcpServers` section (config.json or agent.json). A server needs
 * a `command` (stdio) or `url` (remote); everything else drops tolerantly. */
export function parseMcpServers(raw: unknown): Record<string, McpServerConfig> | undefined {
  if (!isRecord(raw)) return undefined;
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) continue;
    const server: McpServerConfig = {};
    if (typeof value.command === "string" && value.command.trim()) server.command = value.command.trim();
    if (Array.isArray(value.args)) server.args = value.args.filter((arg): arg is string => typeof arg === "string");
    if (isRecord(value.env)) {
      const env = Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      if (Object.keys(env).length > 0) server.env = env;
    }
    if (typeof value.url === "string" && value.url.trim()) server.url = value.url.trim();
    if (server.command || server.url) servers[name] = server;
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/** Effective MCP servers for an agent: workspace set ∪ agent set (agent wins). */
export function resolveMcpServers(
  workspace: Pick<WorkspaceConfig, "mcpServers">,
  agent: { mcpServers?: Record<string, McpServerConfig> },
): Record<string, McpServerConfig> {
  return { ...(workspace.mcpServers ?? {}), ...(agent.mcpServers ?? {}) };
}

/** Parse a `memory` patch (agent.json override or config.json section).
 * Unknown/bad fields drop; an empty patch returns undefined. */
export function parseMemoryPatch(raw: unknown): MemoryConfigPatch | undefined {
  if (!isRecord(raw)) return undefined;
  const patch: MemoryConfigPatch = {};
  if (typeof raw.autoRecall === "boolean") patch.autoRecall = raw.autoRecall;
  if (typeof raw.autoRecallBudget === "number" && raw.autoRecallBudget >= 0) patch.autoRecallBudget = Math.floor(raw.autoRecallBudget);
  if (raw.embeddings === "auto" || raw.embeddings === "off") patch.embeddings = raw.embeddings;
  else if (isRecord(raw.embeddings) && typeof raw.embeddings.provider === "string" && raw.embeddings.provider.trim()) {
    patch.embeddings = {
      provider: raw.embeddings.provider.trim(),
      ...(typeof raw.embeddings.model === "string" && raw.embeddings.model.trim() ? { model: raw.embeddings.model.trim() } : {}),
      ...(typeof raw.embeddings.baseUrl === "string" && raw.embeddings.baseUrl.trim() ? { baseUrl: raw.embeddings.baseUrl.trim() } : {}),
      ...(typeof raw.embeddings.envKey === "string" && raw.embeddings.envKey.trim() ? { envKey: raw.embeddings.envKey.trim() } : {}),
    };
  }
  if (isRecord(raw.consolidate)) {
    const consolidate: Partial<MemoryConfig["consolidate"]> = {};
    if (typeof raw.consolidate.enabled === "boolean") consolidate.enabled = raw.consolidate.enabled;
    if (typeof raw.consolidate.idleMinutes === "number" && raw.consolidate.idleMinutes > 0) consolidate.idleMinutes = raw.consolidate.idleMinutes;
    if (typeof raw.consolidate.maxPerDay === "number" && raw.consolidate.maxPerDay > 0) consolidate.maxPerDay = Math.floor(raw.consolidate.maxPerDay);
    if (isRecord(raw.consolidate.model)) {
      const model: { provider?: string; name?: string } = {};
      if (typeof raw.consolidate.model.provider === "string") model.provider = raw.consolidate.model.provider;
      if (typeof raw.consolidate.model.name === "string") model.name = raw.consolidate.model.name;
      if (Object.keys(model).length) consolidate.model = model;
    }
    if (Object.keys(consolidate).length) patch.consolidate = consolidate;
  }
  if (typeof raw.decayHalfLifeDays === "number" && raw.decayHalfLifeDays > 0) patch.decayHalfLifeDays = raw.decayHalfLifeDays;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Layer a memory patch over a base config (defaults ← workspace ← agent). */
export function resolveMemoryConfig(base: MemoryConfig, patch: MemoryConfigPatch | undefined): MemoryConfig {
  if (!patch) return base;
  return {
    autoRecall: patch.autoRecall ?? base.autoRecall,
    autoRecallBudget: patch.autoRecallBudget ?? base.autoRecallBudget,
    embeddings: patch.embeddings ?? base.embeddings,
    consolidate: { ...base.consolidate, ...patch.consolidate },
    decayHalfLifeDays: patch.decayHalfLifeDays ?? base.decayHalfLifeDays,
  };
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
    memory: resolveMemoryConfig(MEMORY_DEFAULTS, parseMemoryPatch(obj.memory)),
  };
  if (typeof obj.harness === "string" && validHarness(obj.harness)) config.harness = obj.harness;
  if (typeof obj.maxSummonsPerRoom === "number" && Number.isInteger(obj.maxSummonsPerRoom) && obj.maxSummonsPerRoom > 0) {
    config.maxSummonsPerRoom = obj.maxSummonsPerRoom;
  }
  const sandbox = parseSandboxConfig(obj.sandbox);
  if (sandbox) config.sandbox = sandbox;
  const mcpServers = parseMcpServers(obj.mcpServers);
  if (mcpServers) config.mcpServers = mcpServers;
  const hooks = parseHooksConfig(obj.hooks);
  if (hooks) config.hooks = hooks;
  return config;
}
