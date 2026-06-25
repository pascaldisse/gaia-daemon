// Circuit breaker — adapted from nanoclaw's startup-backoff into a per-target,
// in-memory breaker around RunnerHost's spawn→ready handshake. Every harness turn
// and every summon spawns an agent-runner through RunnerHost; when a target keeps
// failing to launch (a fail-closed sandbox off darwin, a missing binary, a harness
// that crashes before it reports `ready`) the old behaviour was to re-spawn on
// every turn. This trips after N consecutive launch failures, fast-fails during a
// cooldown so a flaky provider/harness/agent stops being hammered, then half-opens
// for a single probe and closes again on a clean launch.
//
// In-memory by design (nanoclaw's is file-backed because it guards daemon STARTUP
// across process restarts; this guards launches WITHIN a running daemon). A daemon
// restart resets every breaker — which is what you want, since restarting is itself
// the operator saying "try again".
//
// Keyed by target (`harness:provider/model`) and shared daemon-wide via
// `defaultBreaker`, so when a provider is down every room's turns for it fast-fail,
// not just the one that happened to trip it.

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Consecutive launch failures that trip the breaker open. */
  threshold: number;
  /** Cooldown per trip count (index = trips-1, last value caps). */
  cooldownScheduleMs: number[];
  /** Idle window after which a target's counters are considered stale and reset. */
  resetMs: number;
  /** Injectable clock (real code uses Date.now; tests drive it). */
  now: () => number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  threshold: 3,
  cooldownScheduleMs: [5_000, 15_000, 60_000, 300_000],
  resetMs: 60 * 60_000,
  now: () => Date.now(),
};

interface TargetState {
  state: BreakerState;
  failures: number; // consecutive launch failures while closed
  trips: number; // consecutive opens; drives cooldown length
  openedAt: number;
  lastEventAt: number;
}

export interface AttemptDecision {
  allowed: boolean;
  /** When blocked, ms until the next probe is permitted. */
  retryInMs?: number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  failures: number;
  trips: number;
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly targets = new Map<string, TargetState>();

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  private fresh(now: number): TargetState {
    return { state: "closed", failures: 0, trips: 0, openedAt: 0, lastEventAt: now };
  }

  // Fetch a target's state, first resetting it if it has been idle past the reset
  // window — a target that misbehaved an hour ago starts clean.
  private get(key: string): TargetState {
    const now = this.config.now();
    let t = this.targets.get(key);
    if (!t) {
      t = this.fresh(now);
      this.targets.set(key, t);
    } else if (now - t.lastEventAt > this.config.resetMs) {
      Object.assign(t, this.fresh(now));
    }
    return t;
  }

  private cooldownMs(trips: number): number {
    const schedule = this.config.cooldownScheduleMs;
    if (schedule.length === 0) return 0;
    return schedule[Math.min(Math.max(trips - 1, 0), schedule.length - 1)];
  }

  /** May a launch for this target proceed right now? */
  canAttempt(key: string): AttemptDecision {
    const t = this.get(key);
    if (t.state === "closed" || t.state === "half-open") return { allowed: true };
    // open: allow a single probe once the cooldown has elapsed, else fast-fail.
    const elapsed = this.config.now() - t.openedAt;
    const cooldown = this.cooldownMs(t.trips);
    if (elapsed >= cooldown) {
      t.state = "half-open";
      return { allowed: true };
    }
    return { allowed: false, retryInMs: cooldown - elapsed };
  }

  /** Record a clean launch — closes the breaker and clears the target's history. */
  onSuccess(key: string): void {
    const t = this.get(key);
    Object.assign(t, this.fresh(this.config.now()));
  }

  /** Record a failed launch — trips open on the Nth consecutive failure (or any failure of a half-open probe). */
  onFailure(key: string): void {
    const now = this.config.now();
    const t = this.get(key);
    t.lastEventAt = now;
    if (t.state === "half-open") {
      // The probe failed — back to open with a longer cooldown.
      t.state = "open";
      t.trips += 1;
      t.openedAt = now;
      return;
    }
    t.failures += 1;
    if (t.failures >= this.config.threshold) {
      t.state = "open";
      t.trips += 1;
      t.openedAt = now;
    }
  }

  snapshot(key: string): BreakerSnapshot {
    const t = this.get(key);
    return { state: t.state, failures: t.failures, trips: t.trips };
  }
}

/** Daemon-wide breaker shared by every RunnerHost (override per-host in tests). */
export const defaultBreaker = new CircuitBreaker();
