import type { ModelReasoningOverride, ThinkingLevel } from "./types.js";

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export function parseModelReasoningOverrides(raw: unknown): Record<string, Record<string, ModelReasoningOverride>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const providers: Record<string, Record<string, ModelReasoningOverride>> = {};
  for (const [provider, modelsRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!provider.trim() || !modelsRaw || typeof modelsRaw !== "object" || Array.isArray(modelsRaw)) continue;
    const models: Record<string, ModelReasoningOverride> = {};
    for (const [model, overrideRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
      if (!model.trim() || !overrideRaw || typeof overrideRaw !== "object" || Array.isArray(overrideRaw)) continue;
      const value = overrideRaw as Record<string, unknown>;
      const supportedLevels = Array.isArray(value.supportedLevels)
        ? [...new Set(value.supportedLevels.filter((level): level is ThinkingLevel => REASONING_LEVELS.includes(level as ThinkingLevel)))]
        : undefined;
      const defaultLevel = REASONING_LEVELS.includes(value.defaultLevel as ThinkingLevel) ? value.defaultLevel as ThinkingLevel : undefined;
      const override: ModelReasoningOverride = {};
      if (supportedLevels?.length) override.supportedLevels = supportedLevels;
      if (defaultLevel && (!supportedLevels || supportedLevels.includes(defaultLevel))) override.defaultLevel = defaultLevel;
      if (Object.keys(override).length) models[model] = override;
    }
    if (Object.keys(models).length) providers[provider] = models;
  }
  return Object.keys(providers).length ? providers : undefined;
}

export function mergeModelReasoningOverrides(
  base?: Record<string, Record<string, ModelReasoningOverride>>,
  patch?: Record<string, Record<string, ModelReasoningOverride>>,
): Record<string, Record<string, ModelReasoningOverride>> | undefined {
  if (!base && !patch) return undefined;
  const merged: Record<string, Record<string, ModelReasoningOverride>> = {};
  for (const provider of new Set([...Object.keys(base ?? {}), ...Object.keys(patch ?? {})])) {
    merged[provider] = { ...(base?.[provider] ?? {}), ...(patch?.[provider] ?? {}) };
  }
  return merged;
}
