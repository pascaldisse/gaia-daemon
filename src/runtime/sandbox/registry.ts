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
  /** Working dir; mounted read-only by an isolating backend unless also writable. */
  cwd: string;
  /** Extra dirs the agent may write (subpaths of cwd or absolute). */
  writable: string[];
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

/**
 * Resolve the effective policy above the harness: agent override wins over the
 * workspace default; summons default to enabled (the original ask). Backend
 * defaults to "none", so an enabled policy with no configured backend is a safe
 * no-op until a real backend is set — summons never break for lack of a runtime.
 */
export function resolveSandboxPolicy(workspace: SandboxConfig | undefined, agent: SandboxConfig | undefined, isSummon: boolean): SandboxPolicy {
  const ws = workspace ?? {};
  const ag = agent ?? {};
  return {
    enabled: ag.enabled ?? ws.enabled ?? isSummon,
    backend: ag.backend ?? ws.backend ?? "none",
    writable: ag.writable ?? ws.writable,
    net: ag.net ?? ws.net,
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
 */
export async function resolveSandboxLaunch(policy: SandboxPolicy, argv: string[], cwd: string): Promise<SandboxLaunch> {
  const backendId = policy.backend ?? "none";
  if (!policy.enabled || backendId === "none") return passthrough({ argv, cwd, writable: policy.writable ?? [], net: policy.net ?? "full" });

  const backend = sandboxBackend(backendId);
  if (!backend) throw new Error(`Unknown sandbox backend: ${backendId}`);
  if (!(await backend.available())) {
    throw new Error(`Sandbox backend "${backendId}" is unavailable; refusing to run unsandboxed (fail-closed).`);
  }
  return backend.wrap({ argv, cwd, writable: policy.writable ?? [], net: policy.net ?? "full" });
}
