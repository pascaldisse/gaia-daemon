import type { Model } from "@earendil-works/pi-ai";

// Claude 5-generation models accept only adaptive thinking
// (`thinking.type: "adaptive"`); `thinking.type: "enabled"` is rejected with
// 400 "not supported for this model". pi-ai switches adaptive on only when
// `compat.forceAdaptiveThinking` is set, and the remote model catalog ships the
// 5-gen Claude entries without it. Set it here, uniformly, for every
// anthropic-messages model whose id is Claude major ≥ 5. An explicit value
// from the catalog (true or false) is respected.
const CLAUDE_MAJOR = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)/;
const ADAPTIVE_FROM_MAJOR = 5;

export function withAdaptiveThinkingCompat<T extends Model<any>>(model: T | undefined): T | undefined {
  if (!model || model.api !== "anthropic-messages") return model;
  const major = Number(CLAUDE_MAJOR.exec(model.id)?.[1]);
  if (!(major >= ADAPTIVE_FROM_MAJOR)) return model;
  const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined;
  if (compat?.forceAdaptiveThinking !== undefined) return model;
  return { ...model, compat: { ...(compat ?? {}), forceAdaptiveThinking: true } } as T;
}
