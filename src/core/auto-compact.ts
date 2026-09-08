import type { AutoCompactConfig, AutoCompactPolicy } from "./types/workspace.js";

export const AUTO_COMPACT_DEFAULTS: AutoCompactConfig = { thresholdPct: null, thresholdTokens: 180_000, cooldownTurns: 1 };

/** Invalid fields → absent; explicit null → disabled threshold. */
export function parseAutoCompactOverrides(raw: unknown): Partial<AutoCompactPolicy> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const result: Partial<AutoCompactPolicy> = {};
  if (value.thresholdPct === null || (typeof value.thresholdPct === "number" && Number.isFinite(value.thresholdPct) && value.thresholdPct >= 0 && value.thresholdPct <= 100)) result.thresholdPct = value.thresholdPct;
  if (value.thresholdTokens === null || (typeof value.thresholdTokens === "number" && Number.isSafeInteger(value.thresholdTokens) && value.thresholdTokens > 0)) result.thresholdTokens = value.thresholdTokens;
  if (typeof value.cooldownTurns === "number" && Number.isSafeInteger(value.cooldownTurns) && value.cooldownTurns >= 0) result.cooldownTurns = value.cooldownTurns;
  return result;
}

/** Global → workspace → room; threshold pair atomic, cooldown independent.
 * Both thresholds numeric → tokens wins. Either threshold alone null → off. */
export function parseAutoCompactConfig(raw: unknown, base: AutoCompactConfig = AUTO_COMPACT_DEFAULTS): AutoCompactConfig {
  const patch = parseAutoCompactOverrides(raw);
  const hasThreshold = patch.thresholdPct !== undefined || patch.thresholdTokens !== undefined;
  return {
    ...(hasThreshold ? {
      thresholdPct: patch.thresholdTokens != null ? null : patch.thresholdPct ?? null,
      ...(patch.thresholdTokens === undefined ? {} : { thresholdTokens: patch.thresholdTokens }),
    } : { thresholdPct: base.thresholdPct, ...(base.thresholdTokens === undefined ? {} : { thresholdTokens: base.thresholdTokens }) }),
    cooldownTurns: patch.cooldownTurns ?? base.cooldownTurns,
    ...mergeModelOverrides(raw, base.modelOverrides),
  };
}

export function autoCompactEnabled(config: AutoCompactConfig): boolean {
  return config.thresholdTokens != null || config.thresholdPct !== null;
}

/** Merge partial model policies without materializing defaults at each leaf. */
function mergeModelOverrides(raw: unknown, base: AutoCompactConfig["modelOverrides"]): Pick<AutoCompactConfig, "modelOverrides"> {
  const input = raw && typeof raw === "object" && "modelOverrides" in raw ? raw.modelOverrides : undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return base ? { modelOverrides: base } : {};
  const providers = new Map(Object.entries(base ?? {}));
  for (const [provider, models] of Object.entries(input)) {
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    const entries = new Map(Object.entries(providers.get(provider) ?? {}));
    for (const [model, value] of Object.entries(models)) {
      const patch = parseAutoCompactOverrides(value);
      if (!Object.keys(patch).length) continue;
      const previous = entries.get(model) ?? {};
      const { thresholdPct: _pct, thresholdTokens: _tokens, ...rest } = previous;
      entries.set(model, { ...(patch.thresholdPct !== undefined || patch.thresholdTokens !== undefined ? rest : previous), ...patch });
    }
    if (entries.size) providers.set(provider, Object.fromEntries(entries));
  }
  return providers.size ? { modelOverrides: Object.fromEntries(providers) } : {};
}
