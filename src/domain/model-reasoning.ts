import { REASONING_LEVELS } from "../core/model-reasoning-config.js";
import type { AgentModelConfig, ModelReasoningDescriptor, ModelReasoningOverride, NativeModelReasoning, ThinkingLevel } from "../core/types.js";

const LEVEL_ORDER = new Map(REASONING_LEVELS.map((level, index) => [level, index]));

export function modelReasoningOverride(
  overrides: Record<string, Record<string, ModelReasoningOverride>> | undefined,
  model: AgentModelConfig | undefined,
): ModelReasoningOverride | undefined {
  return model?.provider && model.name ? overrides?.[model.provider]?.[model.name] : undefined;
}

/** Native metadata + GAIA override -> one exact provider/model capability descriptor. */
export function describeModelReasoning(
  provider: string,
  model: string,
  native: NativeModelReasoning | undefined,
  override?: ModelReasoningOverride,
): ModelReasoningDescriptor {
  if (!native && !override) return { status: "unknown", provider, model };
  const levels = override?.supportedLevels ?? native?.levels.map((choice) => choice.level) ?? [];
  const nativeByLevel = new Map(native?.levels.map((choice) => [choice.level, choice.providerValue]));
  const grouped = new Map<string, ThinkingLevel[]>();
  for (const level of levels) {
    const providerValue = nativeByLevel.get(level) ?? level;
    grouped.set(providerValue, [...(grouped.get(providerValue) ?? []), level]);
  }
  const choices = [...grouped.entries()].map(([providerValue, aliases]) => {
    const canonical = aliases.find((level) => level === providerValue) ?? aliases[aliases.length - 1]!;
    return { level: canonical, providerValue, ...(aliases.length > 1 ? { aliases: aliases.filter((level) => level !== canonical) } : {}) };
  }).sort((a, b) => (LEVEL_ORDER.get(a.level) ?? 99) - (LEVEL_ORDER.get(b.level) ?? 99));
  const defaultLevel = override?.defaultLevel ?? native?.defaultLevel;
  return {
    status: "known",
    provider,
    model,
    choices,
    ...(defaultLevel && choices.some((choice) => choice.level === defaultLevel || choice.aliases?.includes(defaultLevel)) ? { defaultLevel } : {}),
    adaptive: native?.adaptive ?? false,
    source: override ? "override" : "discovered",
  };
}

export function resolveReasoningLevel(
  descriptor: ModelReasoningDescriptor,
  requestedLevel: ThinkingLevel | undefined,
  explicit: boolean,
): ModelReasoningDescriptor {
  if (descriptor.status === "unknown") return requestedLevel ? { ...descriptor, requestedLevel } : descriptor;
  if (!requestedLevel) {
    const effectiveLevel = descriptor.defaultLevel ?? descriptor.choices[0]?.level;
    return effectiveLevel ? { ...descriptor, effectiveLevel, resolution: "inherited" } : descriptor;
  }
  const choice = descriptor.choices.find((entry) => entry.level === requestedLevel || entry.aliases?.includes(requestedLevel));
  if (choice) return { ...descriptor, requestedLevel, effectiveLevel: choice.level, resolution: explicit ? "requested" : "inherited" };
  if (explicit) throw new Error(`Thinking level ${requestedLevel} is unsupported for ${descriptor.provider}/${descriptor.model}. Use one of: ${descriptor.choices.map((entry) => entry.level).join(", ") || "none"}`);
  const effectiveLevel = descriptor.choices[0]?.level;
  return { ...descriptor, requestedLevel, ...(effectiveLevel ? { effectiveLevel } : {}), resolution: "conservative" };
}
