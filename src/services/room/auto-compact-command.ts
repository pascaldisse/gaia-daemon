import type { AutoCompactConfig } from "../../core/types.js";

export const AUTO_COMPACT_USAGE = "Usage: /autocompact <0-100|180k|180000 tokens|off> [cooldownTurns]";

/** Explicit token units; bare numbers retain legacy percentage semantics. */
export function parseAutoCompactThreshold(raw: string): Pick<AutoCompactConfig, "thresholdPct" | "thresholdTokens"> | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "off") return { thresholdPct: null };
  const tokens = /^(\d+(?:\.\d+)?)k$/.exec(value) ?? /^(\d+)\s+tokens$/.exec(value);
  if (tokens) {
    const count = Number(tokens[1]) * (value.endsWith("k") ? 1_000 : 1);
    return Number.isSafeInteger(count) && count > 0 ? { thresholdPct: null, thresholdTokens: count } : undefined;
  }
  const pct = Number(value);
  return value && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? { thresholdPct: pct } : undefined;
}
