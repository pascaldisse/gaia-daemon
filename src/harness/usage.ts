// Provider-level usage clients shared by the harness adapters. Usage is a
// property of a SUBSCRIPTION ACCOUNT ("anthropic", "openai"), not of a harness:
// claude and pi both hold Anthropic OAuth, codex and pi both hold ChatGPT
// OAuth. Each harness declares WHICH accounts it can read (usageAccounts on
// its spec — data, per RULE #0) and composes these fetchers to do the reading;
// the daemon's UsageService dedupes candidates by account id and tries them in
// turn, so one broken credential store (a locked keychain, say) never blanks a
// meter another store can still feed. Everything here is pure provider
// knowledge — no harness ids, no daemon state.

import type { UsageLimits, UsageProbeResult, UsageWindow } from "../core/types.js";

/** Best-effort display identity from an OAuth JWT. Account specs may call this
 * without the shared account manager ever interpreting credential bags. */
export function emailFromJwt(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.includes("@") ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** Account id for Anthropic subscription usage (Claude session/weekly caps). */
export const ANTHROPIC_USAGE_ACCOUNT = "anthropic";
/** Account id for OpenAI/ChatGPT subscription usage (codex 5h/weekly caps). */
export const OPENAI_USAGE_ACCOUNT = "openai";

/** One network probe must never stall the whole refresh round. */
export const USAGE_TIMEOUT_MS = 6000;

const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CHATGPT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

/** Parse a Retry-After header (delta-seconds or HTTP-date) into a backoff in ms.
 * A 429 without the header still means "back off" — fall back to a minute so a
 * rate-limited endpoint isn't hammered by the post-turn refresh. */
export function parseRetryAfterMs(res: Response): number {
  const fallback = 60_000;
  const raw = res.headers.get("retry-after");
  if (!raw) return fallback;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return fallback;
}

/** Classify a non-2xx usage response uniformly. Rate-limited (429), provider
 * hiccup (5xx), or a token caught mid-rotation (401/403) are TRANSIENT: keep
 * the last-known meter and back off (honouring Retry-After) instead of
 * hammering — the hammering is what earns the 429. Any other hard 4xx is
 * authoritative "nothing to show". */
function classifyHttpFailure(res: Response): UsageProbeResult {
  if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
    return { status: "error", retryAfterMs: parseRetryAfterMs(res) };
  }
  return { status: "none" };
}

/** GET with a hard timeout; a thrown fetch (offline/DNS/abort) is transient. */
async function fetchJson(url: string, headers: Record<string, string>): Promise<{ body: unknown } | UsageProbeResult> {
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { status: "error" }; // offline / aborted / DNS — keep the last-known value, don't blank it.
  }
  if (!res.ok) return classifyHttpFailure(res);
  try {
    return { body: (await res.json()) as unknown };
  } catch {
    return { status: "error" }; // truncated/unparseable body — transient, keep last-known.
  }
}

// ---------------------------------------------------------------------------
// Anthropic — the same session/weekly caps Claude Code's `/usage` renders.

/** One entry of the Anthropic endpoint's normalized `limits[]`. */
export interface AnthropicRawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string;
  is_active?: boolean;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

function anthropicLabel(limit: AnthropicRawLimit): string {
  switch (limit.kind) {
    case "session":
      return "Current session";
    case "weekly_all":
      return "Weekly · all models";
    case "weekly_scoped": {
      const model = limit.scope?.model?.display_name;
      return model ? `Weekly · ${model}` : "Weekly · scoped";
    }
    default:
      return limit.group === "weekly" ? "Weekly" : (limit.kind ?? "Usage");
  }
}

/** Map the provider severity onto ours, deriving from percent when absent. */
function severityFromPercent(pct: number): UsageWindow["severity"] {
  return pct >= 95 ? "critical" : pct >= 80 ? "warning" : "normal";
}

function anthropicSeverity(limit: AnthropicRawLimit): UsageWindow["severity"] {
  if (limit.severity === "critical" || limit.severity === "warning" || limit.severity === "normal") return limit.severity;
  return severityFromPercent(limit.percent ?? 0);
}

const clampPct = (value: number | undefined): number => Math.max(0, Math.min(100, Math.round(value ?? 0)));

/** Pure mapper: Anthropic usage payload → UsageLimits (null = no caps reported).
 * Reports the session cap, the all-models weekly cap, and EVERY per-model
 * weekly cap (each tagged with its model). The status bar defaults to the
 * account-wide windows and reveals a per-model cap only when that model is
 * active in the open room — that room-awareness is client-side, so the mapper
 * stays account-global and just hands over everything it knows. */
export function mapAnthropicUsage(payload: { limits?: AnthropicRawLimit[] }, plan?: string): UsageLimits | null {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const rank: Record<string, number> = { session: 0, weekly_all: 1, weekly_scoped: 2 };
  const windows: UsageWindow[] = limits
    .filter((limit) => limit.kind === "session" || limit.kind === "weekly_all" || limit.kind === "weekly_scoped")
    .sort((a, b) => (rank[a.kind ?? ""] ?? 9) - (rank[b.kind ?? ""] ?? 9))
    .map((limit) => {
      const model = limit.kind === "weekly_scoped" ? limit.scope?.model?.display_name : undefined;
      return {
        kind: limit.kind ?? "usage",
        label: anthropicLabel(limit),
        percent: clampPct(limit.percent),
        severity: anthropicSeverity(limit),
        ...(typeof limit.resets_at === "string" ? { resetsAt: limit.resets_at } : {}),
        ...(model ? { model } : {}),
      };
    });
  if (windows.length === 0) return null;
  return {
    account: ANTHROPIC_USAGE_ACCOUNT,
    ...(plan ? { plan } : {}),
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

/** Fetch Anthropic account usage with a Claude OAuth access token. */
export async function fetchAnthropicUsage(accessToken: string, plan?: string): Promise<UsageProbeResult> {
  const outcome = await fetchJson(ANTHROPIC_USAGE_ENDPOINT, {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  if ("status" in outcome) return outcome;
  const usage = mapAnthropicUsage(outcome.body as { limits?: AnthropicRawLimit[] }, plan);
  return usage ? { status: "ok", usage } : { status: "none" }; // authenticated but no caps reported — nothing to show.
}

// ---------------------------------------------------------------------------
// OpenAI/ChatGPT — the codex CLI's rate-limit meter (5h primary window +
// weekly secondary window), read from the same backend codex itself polls.

interface ChatGptRawWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number; // unix seconds
}

export interface ChatGptRawUsage {
  plan_type?: string;
  rate_limit?: {
    primary_window?: ChatGptRawWindow | null;
    secondary_window?: ChatGptRawWindow | null;
  } | null;
}

function chatGptWindow(raw: ChatGptRawWindow | null | undefined, kind: string, label: string): UsageWindow | undefined {
  if (!raw || typeof raw.used_percent !== "number") return undefined;
  const percent = clampPct(raw.used_percent);
  return {
    kind,
    label,
    percent,
    severity: severityFromPercent(percent),
    ...(typeof raw.reset_at === "number" ? { resetsAt: new Date(raw.reset_at * 1000).toISOString() } : {}),
  };
}

/** Human window-length tag, e.g. "5h" from 18000s — the label mirrors what the
 * server actually enforces rather than hardcoding today's plan shape. */
function windowSpanLabel(seconds: number | undefined): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const hours = seconds / 3600;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Pure mapper: ChatGPT wham/usage payload → UsageLimits (null = no meters). */
export function mapChatGptUsage(payload: ChatGptRawUsage): UsageLimits | null {
  const primarySpan = windowSpanLabel(payload.rate_limit?.primary_window?.limit_window_seconds);
  const windows = [
    chatGptWindow(payload.rate_limit?.primary_window, "session", primarySpan ? `Current session (${primarySpan})` : "Current session"),
    chatGptWindow(payload.rate_limit?.secondary_window, "weekly_all", "Weekly · all models"),
  ].filter((win): win is UsageWindow => win !== undefined);
  if (windows.length === 0) return null;
  return {
    account: OPENAI_USAGE_ACCOUNT,
    ...(typeof payload.plan_type === "string" && payload.plan_type ? { plan: payload.plan_type } : {}),
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

/** Fetch ChatGPT account usage with a codex OAuth access token. */
export async function fetchChatGptUsage(accessToken: string, accountId?: string): Promise<UsageProbeResult> {
  const outcome = await fetchJson(CHATGPT_USAGE_ENDPOINT, {
    Authorization: `Bearer ${accessToken}`,
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    "User-Agent": "codex-cli",
  });
  if ("status" in outcome) return outcome;
  const usage = mapChatGptUsage(outcome.body as ChatGptRawUsage);
  return usage ? { status: "ok", usage } : { status: "none" }; // authenticated but no meters reported — nothing to show.
}
