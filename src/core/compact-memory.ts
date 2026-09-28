// Compaction MEMORY policy (how a fold is written), distinct from
// auto-compact.ts (WHEN a fold fires). Ideas ported from connectome-host's
// AutobiographicalStrategy (@animalabs/context-manager 0.11.0, MIT) — see
// docs/connectome-memory.md. `.gaia/config.json` key: `compact`.

type CompactSummaryVoice = "agent" | "neutral";
type CompactSummaryModel = "self" | "fallback";

export interface CompactMemoryConfig {
  /** agent = first-person memory written by the agent (its own system prompt
   * + name); neutral = pi's stock 3rd-person checkpoint, byte-for-byte the
   * pre-connectome behaviour. */
  summaryVoice: CompactSummaryVoice;
  /** self = the session's own model forms the memory (sonnet fallback only on
   * failure); fallback = legacy order (sonnet first). */
  summaryModel: CompactSummaryModel;
  /** Earliest N folded messages pinned VERBATIM at the summary head and carried
   * byte-identical through every later fold (connectome headWindow). 0 = off. */
  stablePrefixEvents: number;
  /** Per-message char bound inside the stable prefix (deterministic cut, so the
   * block is still byte-stable once written). */
  stablePrefixMaxChars: number;
  /** Resolution gradient over the fold window: newest = detail, older =
   * coarser, oldest = one line + recall pointer. false = one flat memory. */
  adaptiveResolution: boolean;
  /** Age windows the fold range is split into (≥2 for a gradient). */
  resolutionWindows: number;
  /** Target tokens of the newest (detail) memory. */
  detailTargetTokens: number;
  /** Each older window gets detail / decay^k tokens. */
  resolutionDecay: number;
  /** Windows with less substantive text than this get a stub line, no LLM
   * (connectome thin-chunk guard, minChunkCharsForLLM). */
  minWindowChars: number;
  /** Max chars of one recall-index line. */
  indexLineChars: number;
  /** Output-token ceiling for the memory call. */
  maxOutputTokens: number;
}

export const COMPACT_MEMORY_DEFAULTS: CompactMemoryConfig = {
  summaryVoice: "agent",
  summaryModel: "self",
  stablePrefixEvents: 4,
  stablePrefixMaxChars: 4_000,
  adaptiveResolution: true,
  resolutionWindows: 3,
  detailTargetTokens: 1_500,
  resolutionDecay: 4,
  minWindowChars: 200,
  indexLineChars: 240,
  maxOutputTokens: 8_000,
};

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/** Invalid fields → inherit base; unknown keys ignored. */
export function parseCompactMemoryConfig(raw: unknown, base: CompactMemoryConfig = COMPACT_MEMORY_DEFAULTS): CompactMemoryConfig {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    summaryVoice: v.summaryVoice === "agent" || v.summaryVoice === "neutral" ? v.summaryVoice : base.summaryVoice,
    summaryModel: v.summaryModel === "self" || v.summaryModel === "fallback" ? v.summaryModel : base.summaryModel,
    stablePrefixEvents: isInt(v.stablePrefixEvents, 0) ? v.stablePrefixEvents : base.stablePrefixEvents,
    stablePrefixMaxChars: isInt(v.stablePrefixMaxChars, 1) ? v.stablePrefixMaxChars : base.stablePrefixMaxChars,
    adaptiveResolution: typeof v.adaptiveResolution === "boolean" ? v.adaptiveResolution : base.adaptiveResolution,
    resolutionWindows: isInt(v.resolutionWindows, 1) ? v.resolutionWindows : base.resolutionWindows,
    detailTargetTokens: isInt(v.detailTargetTokens, 1) ? v.detailTargetTokens : base.detailTargetTokens,
    resolutionDecay: typeof v.resolutionDecay === "number" && Number.isFinite(v.resolutionDecay) && v.resolutionDecay >= 1 ? v.resolutionDecay : base.resolutionDecay,
    minWindowChars: isInt(v.minWindowChars, 0) ? v.minWindowChars : base.minWindowChars,
    indexLineChars: isInt(v.indexLineChars, 40) ? v.indexLineChars : base.indexLineChars,
    maxOutputTokens: isInt(v.maxOutputTokens, 256) ? v.maxOutputTokens : base.maxOutputTokens,
  };
}
