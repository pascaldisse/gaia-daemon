// Swappable sandbox backends. The sandbox sits ABOVE the harness: it wraps the
// one process the daemon spawns to run a turn (the agent-runner), identically
// for every harness, and reads nothing about which harness is inside. Swap the
// backend = change one config value (or drop in one `registerSandbox` file).
//
// The on-disk SandboxConfig shape + its parser live in core (types.ts /
// config.ts); this module owns the RESOLVED policy and the backend registry.

import type { SandboxConfig } from "../../core/types.js";

/** What to run, and the isolation policy for it. */
export interface SandboxSpec {
  /** Full argv to launch (argv[0] is the executable). */
  argv: string[];
  /** Working dir; the workspace the turn may write (it is git-tracked / recoverable). */
  cwd: string;
  /** Extra dirs the agent may write, beyond cwd + temp (absolute, or subpaths of cwd). */
  writable: string[];
  /** Paths kept read-only even though they sit inside writable trees (the
   *  policy files, a harness's declared credential store). Last match wins in
   *  the backend, so these override every writable grant — config-supplied
   *  ones included. */
  readonly: string[];
  /** Extra paths to deny READ access to, on top of the backend's built-in
   *  sensitive set (credentials, user documents). */
  denyRead?: string[];
  /** Is the cwd writable? Default true (a coding agent edits its project). The
   *  pi skill runs its repo read-only and passes false. */
  cwdWritable?: boolean;
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
  /** Rewrite the spec into an actual launch (e.g. `sandbox-exec -p … argv`). */
  wrap(spec: SandboxSpec): SandboxLaunch;
}

/** Per-agent / per-workspace sandbox policy (resolved above the harness). */
export interface SandboxPolicy {
  enabled: boolean;
  /** Backend id; defaults to "none" (no isolation). */
  backend?: string;
  writable?: string[];
  net?: "full" | "none";
  /** Route this turn's LLM calls through the in-daemon credential proxy, so the
   *  real provider key never enters the sandbox. Default OFF. */
  credentialProxy?: boolean;
}

/** The real (isolating) backend to force when isolation is required. macOS
 *  Seatbelt is the only real backend now (apple-container was dropped); off
 *  darwin it is unavailable, so an untrusted turn fail-closes rather than
 *  running naked — the safe outcome for a macOS-first tool. */
function defaultRealBackend(): string {
  return "macos-seatbelt";
}

/**
 * Resolve the effective policy above the harness. Two tiers:
 *
 * - **Untrusted agents** (`trusted === false`) can NEVER run unsandboxed: forced
 *   enabled with a real backend that no config can weaken to "none"/disabled. A
 *   different *real* backend may still be chosen; if it is unavailable,
 *   resolveSandboxLaunch fail-closes (the turn refuses to run) rather than
 *   dropping isolation. This is not overridable — that is the whole point of the
 *   trust tier. Config-supplied `writable` grants do pass through, but they can
 *   never expose governance: RunnerHost carves the workspace policy files and
 *   the agent's own agent.json (the trust bit itself) back to read-only via
 *   `extra.readonly`, which the backend applies AFTER the allows (last match
 *   wins).
 * - **Trusted agents** default to NO sandbox — top-level turns AND summons
 *   alike. A trusted agent is trusted everywhere it runs; its background
 *   workers inherit that, so a summon is not confined merely for being a summon
 *   (this is what lets a subscription-OAuth harness read its keychain login in a
 *   summon). The boundary that still holds is the TRUST tier, not the
 *   summon-ness: a summon launched by — or running under — an untrusted agent is
 *   forced-sandboxed via the untrusted branch above, and no config can weaken
 *   that. A trusted agent may still opt INTO a sandbox explicitly (enabled /
 *   backend, on its own config or the workspace's).
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
  const trusted = opts.trusted !== false; // default trusted; only an explicit false is untrusted
  const real = defaultRealBackend();
  const configuredBackend = ag.backend ?? ws.backend;
  const writable = ag.writable ?? ws.writable;
  const net = ag.net ?? ws.net;
  // Opt-in, default OFF. The proxy only matters once isolation is on, so it
  // rides whatever backend the tiers below resolve.
  const credentialProxy = ag.credentialProxy ?? ws.credentialProxy ?? false;

  if (!trusted) {
    return {
      enabled: true,
      backend: configuredBackend && configuredBackend !== "none" ? configuredBackend : real,
      writable,
      net,
      credentialProxy,
    };
  }

  // Trusted: no sandbox by default, summon or not. `isSummon` no longer forces
  // isolation — a trusted agent's workers run with the same reach it has (so a
  // summoned claude/Fable turn can reach its keychain OAuth login). An explicit
  // enabled/backend still lets a trusted agent opt into confinement.
  return {
    enabled: ag.enabled ?? ws.enabled ?? false,
    backend: configuredBackend ?? "none",
    writable,
    net,
    credentialProxy,
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
  extra: { writable?: string[]; readonly?: string[]; denyRead?: string[]; cwdWritable?: boolean } = {},
): Promise<SandboxLaunch> {
  const spec: SandboxSpec = {
    argv,
    cwd,
    writable: [...(policy.writable ?? []), ...(extra.writable ?? [])],
    readonly: extra.readonly ?? [],
    denyRead: extra.denyRead ?? [],
    cwdWritable: extra.cwdWritable ?? true,
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
