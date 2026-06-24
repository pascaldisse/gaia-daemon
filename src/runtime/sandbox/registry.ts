// Swappable sandbox backends. The sandbox sits ABOVE the harness: it wraps the
// one process the daemon spawns to run a turn (the agent-runner), identically
// for every harness, and reads nothing about which harness is inside. Swap the
// backend = change one config value (or drop in one `registerSandbox` file).
//
// This is the daemon analogue of NanoClaw's container-runtime.ts one-file swap.

/** What to run, and the isolation policy for it. */
export interface SandboxSpec {
  /** Full argv to launch (argv[0] is the executable). */
  argv: string[];
  /** Working dir; the workspace the turn may write (it is git-tracked / recoverable). */
  cwd: string;
  /** Extra dirs the agent may write, beyond cwd + temp (absolute, or subpaths of cwd). */
  writable: string[];
  /** Paths kept read-only even though they sit inside cwd (the policy files). */
  readonly: string[];
  /**
   * Env var NAMES the backend should carry into the isolated process. Used by
   * backends that don't inherit the parent env automatically (a container only
   * sees what `--env NAME` forwards). Values are read from the launched
   * process's own environment, so secrets never appear in argv. Host-confining
   * backends (seatbelt) ignore this — they already inherit the full env.
   */
  forwardEnv: string[];
  /** Network access. */
  net: "full" | "none";
}

/** The launch a backend produced: a possibly-rewritten argv. */
export interface SandboxLaunch {
  command: string;
  args: string[];
}

export interface SandboxBackend {
  id: string;
  /** True when this backend can run here (binary present, etc.). */
  available(): boolean | Promise<boolean>;
  /** Rewrite the spec into an actual launch (e.g. `container run … argv`). */
  wrap(spec: SandboxSpec): SandboxLaunch;
}

/** Per-agent / per-workspace sandbox policy (resolved above the harness). */
export interface SandboxPolicy {
  enabled: boolean;
  /** Backend id; defaults to "none" (no isolation). */
  backend?: string;
  writable?: string[];
  net?: "full" | "none";
}

/** The partial form written in config.json / agent.json (all fields optional). */
export interface SandboxConfig {
  enabled?: boolean;
  backend?: string;
  writable?: string[];
  net?: "full" | "none";
}

/** Validate a raw JSON value into a SandboxConfig (drops unknown/bad fields). */
export function parseSandboxConfig(raw: unknown): SandboxConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const config: SandboxConfig = {};
  if (typeof obj.enabled === "boolean") config.enabled = obj.enabled;
  if (typeof obj.backend === "string") config.backend = obj.backend;
  if (Array.isArray(obj.writable)) config.writable = obj.writable.filter((value): value is string => typeof value === "string");
  if (obj.net === "full" || obj.net === "none") config.net = obj.net;
  return config;
}

/** The real (isolating) backend to force when isolation is required. */
function defaultRealBackend(platform: string): string {
  return platform === "darwin" ? "macos-seatbelt" : "apple-container";
}

/**
 * Resolve the effective policy above the harness. Two tiers:
 *
 * - **Untrusted agents** (`trusted === false`) can NEVER run unsandboxed: forced
 *   enabled with a real backend that no config can weaken to "none"/disabled. A
 *   different *real* backend may still be chosen; if it is unavailable,
 *   resolveSandboxLaunch fail-closes (the turn refuses to run) rather than
 *   dropping isolation. This is not overridable — that is the whole point of the
 *   trust tier.
 * - **Trusted agents** default a *summon* to a real backend too (summons are
 *   never naked by default), but a trusted agent may override that, including
 *   back to "none". A trusted top-level turn defaults to no sandbox.
 *
 * Agent override wins over the workspace default throughout.
 */
export function resolveSandboxPolicy(
  workspace: SandboxConfig | undefined,
  agent: SandboxConfig | undefined,
  isSummon: boolean,
  opts: { trusted?: boolean; platform?: string } = {},
): SandboxPolicy {
  const ws = workspace ?? {};
  const ag = agent ?? {};
  const platform = opts.platform ?? process.platform;
  const trusted = opts.trusted !== false; // default trusted; only an explicit false is untrusted
  const real = defaultRealBackend(platform);
  const configuredBackend = ag.backend ?? ws.backend;
  const writable = ag.writable ?? ws.writable;
  const net = ag.net ?? ws.net;

  if (!trusted) {
    return {
      enabled: true,
      backend: configuredBackend && configuredBackend !== "none" ? configuredBackend : real,
      writable,
      net,
    };
  }

  return {
    enabled: ag.enabled ?? ws.enabled ?? isSummon,
    backend: configuredBackend ?? (isSummon ? real : "none"),
    writable,
    net,
  };
}

const registry = new Map<string, SandboxBackend>();

export function registerSandbox(backend: SandboxBackend): void {
  registry.set(backend.id, backend);
}

export function sandboxBackend(id: string): SandboxBackend | undefined {
  return registry.get(id);
}

export function sandboxBackendIds(): string[] {
  return [...registry.keys()];
}

/** Identity launch — no isolation. */
function passthrough(spec: SandboxSpec): SandboxLaunch {
  return { command: spec.argv[0], args: spec.argv.slice(1) };
}

/**
 * Resolve a policy to a concrete launch. Fail-closed: if the policy enables a
 * real backend that is unavailable, throw rather than silently running
 * unsandboxed. A disabled policy or the "none" backend is the identity launch.
 * `extra` carries caller-derived paths (the workspace scratch it may write, the
 * policy files it may not) that the policy itself doesn't know about.
 */
export async function resolveSandboxLaunch(
  policy: SandboxPolicy,
  argv: string[],
  cwd: string,
  extra: { writable?: string[]; readonly?: string[]; forwardEnv?: string[] } = {},
): Promise<SandboxLaunch> {
  const spec: SandboxSpec = {
    argv,
    cwd,
    writable: [...(policy.writable ?? []), ...(extra.writable ?? [])],
    readonly: extra.readonly ?? [],
    forwardEnv: extra.forwardEnv ?? [],
    net: policy.net ?? "full",
  };
  const backendId = policy.backend ?? "none";
  if (!policy.enabled || backendId === "none") return passthrough(spec);

  const backend = sandboxBackend(backendId);
  if (!backend) throw new Error(`Unknown sandbox backend: ${backendId}`);
  if (!(await backend.available())) {
    throw new Error(`Sandbox backend "${backendId}" is unavailable; refusing to run unsandboxed (fail-closed).`);
  }
  return backend.wrap(spec);
}
