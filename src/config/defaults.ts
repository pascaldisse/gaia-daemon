// The single source for daemon defaults. Before this, the same values were
// re-typed in three places — the workspace config loader, the runtime factory's
// `?? "pi"`, and the agent scaffold template — so they could drift. Anything a
// fresh install falls back to lives here, once.
//
// Operational limits that exist in exactly one place (SUMMON_TIMEOUT_MS,
// MAX_LIVE_CONTROLLERS, the memory caps, the secret-pattern list) are NOT here:
// a single named constant is already one source of truth. This module is for
// values that were genuinely duplicated, plus the env-overridable bind address.

export const DEFAULTS = {
  /** Default harness when neither the agent nor the workspace picks one. */
  harness: "pi",
  /** Default model for a freshly scaffolded agent. */
  model: { provider: "deepseek", name: "deepseek-v4-pro" },
  /** Default agent id a new workspace points its `defaultAgent` at. */
  defaultAgent: "gaia",
  /** Default (and seed) room id. */
  room: "default",
  /** Default thinking level for a freshly scaffolded agent. */
  thinking: "medium",
  /** Default transcript window (room events fed to a turn). */
  transcriptWindow: 20,
  /** Default per-room concurrent-summon cap. */
  maxSummonsPerRoom: 8,
  /** Default web-server bind address. */
  host: "127.0.0.1",
  port: 8787,
} as const;

/** Web-server host: GAIA_HOST overrides, else the default (mirrors gaiaHome()). */
export function gaiaHost(): string {
  return process.env.GAIA_HOST?.trim() || DEFAULTS.host;
}

/** Web-server port: GAIA_PORT overrides (0 = pick a free port), else the default. */
export function gaiaPort(): number {
  const raw = process.env.GAIA_PORT?.trim();
  if (!raw) return DEFAULTS.port;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULTS.port;
}
