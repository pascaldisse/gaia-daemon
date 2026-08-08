// Subscription-usage meter, account-keyed and survives-everything durable.
// Owns the whole pipeline behind the status-bar chip: gathers each harness's
// declared (account, probe) candidates (usageAccounts — data on the spec, per
// RULE #0), dedupes them by account, probes candidates in order until one
// answers, and persists every accepted snapshot to ~/.gaia/usage.json so a
// daemon restart or an unreachable provider NEVER blanks the chip — the cache
// is loaded at boot BEFORE the first probe and only an authoritative
// "nothing to show" from EVERY candidate clears an account.
//
// Broadcast policy: every `ok` is broadcast, even when the numbers didn't move
// — the payload's fetchedAt is what the client's "pulled Xs ago" line renders,
// and suppressing "unchanged" updates would silently age a perfectly fresh
// meter.

import { globalPaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import type { UiEvent, UsageLimits, UsageProbeResult } from "../core/types.js";
import { usageAccountProbes } from "../harness/spec.js";

// Usage limits change slowly (only your own turns spend, and windows reset on
// their own clock the client counts down locally) — so the interval is just a
// safety net for reset rollovers; the real freshness comes from the post-turn
// debounced refresh.
export const USAGE_POLL_MS = 5 * 60_000;
export const USAGE_REFRESH_DEBOUNCE_MS = 4000;
// A subscription meter moves slowly; never probe more than once per minute from
// the per-turn refresh path (the slow poll, boot probe, and the manual refresh
// button force through). This is the second guard against 429s, alongside each
// probe's own Retry-After.
export const USAGE_MIN_INTERVAL_MS = 60_000;

type UsageEvent = Extract<UiEvent, { type: "usage-limits" }>;

/** What to do with one ACCOUNT's probe round (every candidate outcome, in the
 * order tried — the round stops early at the first `ok`). Pure so the
 * resilience is testable in isolation: the ONLY way a cached meter is cleared
 * is EVERY candidate answering an authoritative `none`; any transient `error`
 * in the round leaves the cache untouched and merely parks the account for the
 * largest backoff any candidate asked for. */
export function reduceAccountProbes(
  prev: UsageLimits | undefined,
  results: UsageProbeResult[],
): { set?: UsageLimits; clear?: true; cooldownMs?: number } {
  const ok = results.find((result) => result.status === "ok");
  if (ok && ok.status === "ok") return { set: ok.usage };
  const backoffs = results.filter((result) => result.status === "error");
  if (backoffs.length > 0) {
    const cooldownMs = Math.max(0, ...backoffs.map((result) => (result.status === "error" ? (result.retryAfterMs ?? 0) : 0)));
    return cooldownMs > 0 ? { cooldownMs } : {};
  }
  // Every candidate said `none` — authoritatively nothing to show.
  return prev ? { clear: true } : {};
}

export interface UsageServiceOptions {
  broadcast(event: UsageEvent): void;
  /** Override the cache file (tests). Default: globalPaths.usageCache(). */
  cachePath?: string;
  /** Override the candidate source (tests). Default: usageAccountProbes(). */
  probes?(): Map<string, Array<() => Promise<UsageProbeResult>>>;
}

export class UsageService {
  /** Latest accepted usage per ACCOUNT — mirrored to disk on every change so a
   * newly-connected client AND a freshly-restarted daemon are seeded instantly. */
  private readonly accounts = new Map<string, UsageLimits>();
  /** Per-account backoff floor: a round that reported a transient failure (e.g.
   * a 429 with Retry-After) parks that account until this instant, so the poll
   * loop stops hammering the very endpoint that rate-limited it. */
  private readonly cooldown = new Map<string, number>();
  /** When the last probe round actually ran — throttles the per-turn refresh so
   * a busy multi-agent room doesn't fire a probe on every task-end. */
  private lastProbeAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private readonly cachePath: string;
  private readonly probes: () => Map<string, Array<() => Promise<UsageProbeResult>>>;

  constructor(private readonly options: UsageServiceOptions) {
    this.cachePath = options.cachePath ?? globalPaths.usageCache();
    this.probes = options.probes ?? usageAccountProbes;
  }

  /** Seed from the disk cache, then start the probe cycle. The load happens
   * BEFORE the first probe so a restart shows the last-known meter immediately
   * — even when every provider is unreachable. */
  async start(): Promise<void> {
    await this.load();
    void this.refresh({ force: true });
    this.pollTimer = setInterval(() => void this.refresh({ force: true }), USAGE_POLL_MS);
    this.pollTimer.unref?.();
  }

  /** Load the persisted per-account snapshots (exposed for tests; start() calls
   * it). Tolerates a missing/corrupt file and skips malformed entries — the
   * cache is a convenience copy, never a source of crashes. */
  async load(): Promise<void> {
    const raw = (await readJson(this.cachePath)) as { accounts?: Record<string, unknown> } | undefined;
    for (const [account, value] of Object.entries(raw?.accounts ?? {})) {
      const usage = value as UsageLimits;
      if (usage && typeof usage === "object" && Array.isArray(usage.windows) && typeof usage.fetchedAt === "string") {
        this.accounts.set(account, { ...usage, account });
      }
    }
  }

  /** Current cached usage as replayable events — used to seed a client the
   * moment it connects (SSE fan-out only carries events broadcast while it's
   * subscribed, so without this a fresh tab shows no chip until the next poll). */
  currentUsage(): UsageEvent[] {
    return [...this.accounts.entries()].map(([account, usage]) => ({ type: "usage-limits", account, usage }));
  }

  /** Current cached usage keyed by account (the manual-refresh endpoint's
   * direct response, so the button works even when SSE hiccups). */
  snapshot(): Record<string, UsageLimits> {
    return Object.fromEntries(this.accounts);
  }

  /** Probe every declared account and broadcast the results. Candidates for one
   * account are tried IN ORDER until one returns `ok` — a locked keychain or a
   * revoked token in one credential store falls through to the next harness
   * that can read the same subscription. Accounts are independent and probed
   * concurrently.
   * @param force bypass the min-interval throttle (boot, slow poll, button).
   * @param manual a human clicked refresh — also bypass a Retry-After cooldown
   *   (one human-paced attempt is exactly what the button promises). */
  async refresh({ force = false, manual = false }: { force?: boolean; manual?: boolean } = {}): Promise<void> {
    if (this.refreshing) return;
    if (!force && Date.now() - this.lastProbeAt < USAGE_MIN_INTERVAL_MS) return;
    this.refreshing = true;
    this.lastProbeAt = Date.now();
    try {
      let changed = false;
      const declared = this.probes();
      // Accounts are editable at runtime. Drop a deleted/renamed binding from
      // the durable cache immediately; otherwise a removed old login can sit
      // in the global usage map forever and accidentally reappear in a room.
      for (const account of [...this.accounts.keys()]) {
        if (declared.has(account)) continue;
        this.accounts.delete(account);
        this.options.broadcast({ type: "usage-limits", account, usage: null });
        changed = true;
      }
      await Promise.all(
        [...declared.entries()].map(async ([account, candidates]) => {
          // Respect a prior transient failure's backoff: leave the cached value
          // in place and skip the calls entirely until the cooldown elapses.
          if (!manual && Date.now() < (this.cooldown.get(account) ?? 0)) return;
          const results: UsageProbeResult[] = [];
          for (const probe of candidates) {
            let result: UsageProbeResult;
            try {
              result = await probe();
            } catch {
              result = { status: "error" }; // a thrown probe is a transient failure, not a clear.
            }
            results.push(result);
            if (result.status === "ok") break; // first candidate that answers wins the round.
          }
          const decision = reduceAccountProbes(this.accounts.get(account), results);
          if (decision.set) {
            // Mapper results identify a provider; this service owns the stable
            // GAIA account key used for persistence and room visibility.
            const usage = { ...decision.set, account };
            this.accounts.set(account, usage);
            changed = true;
            // ALWAYS broadcast an ok — fetchedAt moved even when the numbers
            // didn't, and the client's "pulled Xs ago" must stay honest.
            this.options.broadcast({ type: "usage-limits", account, usage });
          }
          if (decision.clear) {
            this.accounts.delete(account);
            changed = true;
            this.options.broadcast({ type: "usage-limits", account, usage: null });
          }
          // A definitive round (ok/all-none) lifts any backoff; a transient
          // error parks this account so we stop hammering the endpoint.
          if (decision.cooldownMs) this.cooldown.set(account, Date.now() + decision.cooldownMs);
          else if (decision.set || decision.clear) this.cooldown.delete(account);
        }),
      );
      if (changed) await writeJsonAtomic(this.cachePath, { accounts: this.snapshot() });
    } finally {
      this.refreshing = false;
    }
  }

  /** Debounced refresh — a turn's token spend lands a few seconds after it
   * ends, and rapid multi-agent turns coalesce into one probe. */
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, USAGE_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}
