// ---------------------------------------------------------------------------
// Account usage limits (a subscription account's session/weekly caps — NOT
// per-room context). Keyed by ACCOUNT ("anthropic", "openai"), not by harness:
// several harnesses can read the SAME subscription (claude and pi both hold
// Anthropic OAuth), so each harness declares which accounts it can probe as
// DATA on its spec (usageAccounts) and the daemon dedupes by account id —
// one meter per subscription, uniform rendering, never a harness branch. The
// same standing applies to every room/agent on that account, so this is
// broadcast daemon-global, not per-room.

export interface UsageWindow {
  /** Stable window id, e.g. "session" | "weekly_all" | "weekly_scoped". Only
   * used to key/order; display uses `label`. */
  kind: string;
  /** Human label, e.g. "Current session", "Weekly · all models", "Weekly · Fable". */
  label: string;
  /** Percent of the cap consumed, 0–100 (clamped). */
  percent: number;
  /** How close to the cap — drives the status-bar colour. */
  severity: "normal" | "warning" | "critical";
  /** ISO 8601 instant the window resets, when the harness reports one. */
  resetsAt?: string;
  /** For a model-scoped window (e.g. a per-model weekly cap), the model it
   * applies to, as the provider names it (e.g. "Fable"). Absent on account-wide
   * windows (session, all-models weekly). The status bar shows a scoped window
   * only when its model is the active one in the open room. */
  model?: string;
}

export interface UsageLimits {
  /** The GAIA account binding this meters (a named account id, or a stable
   * harness-shared-login id). This is the client key and deliberately is NOT
   * a provider name: two Anthropic logins must never overwrite each other. */
  account: string;
  /** Optional plan/account label, e.g. the subscription tier. */
  plan?: string;
  /** Windows to show, most-relevant first. */
  windows: UsageWindow[];
  /** ISO 8601 instant this snapshot was fetched. */
  fetchedAt: string;
}

/** Outcome of one usage probe candidate. The critical distinction is between
 * an AUTHORITATIVE "nothing to show" (`none` — API-key auth, signed out, no
 * such concept) and a TRANSIENT failure (`error` — rate-limited, offline,
 * token mid-rotation, LOCKED KEYCHAIN). The daemon clears an account's chip
 * only when EVERY candidate says `none`; any `error` keeps the last-known
 * value, so a passing 429/blip/keychain hiccup never blanks a healthy meter.
 * `error` may carry a backoff hint (from a provider Retry-After) the daemon
 * honours uniformly — the harness owns HOW it derives it; the daemon never
 * branches on which harness it is. */
export type UsageProbeResult =
  | { status: "ok"; usage: UsageLimits }
  | { status: "none" }
  | { status: "error"; retryAfterMs?: number };

