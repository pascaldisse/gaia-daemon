// Context diet (09-MEMORY-CONTEXT, ported from v2 commit 8dd8ec4): render-time
// decay for what a room delivers into an agent's turn prompt. Pure types +
// logic here; I/O (global/room policy files) lives in
// services/context-policy-store.ts; the actual decay renderer lives in
// harness/prompt.ts (renderRoomTranscript). Canonical transcript/RoomEvent
// data is NEVER mutated by any of this — decay is projection-only, exactly
// like v2. Default is OFF (IRON, Pascal): a fresh install renders identically
// to pre-diet gaia until a room (or the workspace default) opts in.

/** Same knob names as v2's ContextDietPolicy (09-MEMORY-CONTEXT "Diet
 * projection" + "Diet/efficiency settings"). `preset` is the on/off switch —
 * every other knob is inert while it is false. */
export interface ContextDietPolicy {
  /** Diet on/off. Default false — OFF, IRON (Pascal 2026-08-21). */
  readonly preset: boolean;
  /** Never collapse this agent's own tool calls, regardless of recency. */
  readonly keepAllToolCalls: boolean;
  /** Last N distinct agent-authored room events (nearest the current turn)
   * whose own tool calls stay full; older own tool calls collapse to a
   * one-line stub. 0 = none recognized as recent (always collapse unless
   * keepAllToolCalls). */
  readonly fullTurnWindow: number;
  /** Another agent's tool-call activity is always a bounded-tail stub (last N
   * lines of its preview), independent of recency. */
  readonly toolTailLines: number;
}

/** Partial patch shape accepted by the policy store's set/patch calls — same
 * field names as ContextDietPolicy, all optional. */
export type ContextDietOverrides = Partial<ContextDietPolicy>;

/** v2 parity defaults (same numbers as gaia-daemon-v2's DEFAULT_CONTEXT_DIET_POLICY) — inert until `preset` flips true. */
export const DEFAULT_CONTEXT_DIET_POLICY: ContextDietPolicy = Object.freeze({
  preset: false,
  keepAllToolCalls: false,
  fullTurnWindow: 0,
  toolTailLines: 200,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min = 0): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Tolerant parse of a full policy document (mirrors parseScheduleFile's
 * style): unknown/malformed fields fall back to `fallback`'s value field by
 * field — never throws. */
export function parseContextDietPolicy(raw: unknown, fallback: ContextDietPolicy = DEFAULT_CONTEXT_DIET_POLICY): ContextDietPolicy {
  const obj = isRecord(raw) ? raw : {};
  return {
    preset: typeof obj.preset === "boolean" ? obj.preset : fallback.preset,
    keepAllToolCalls: typeof obj.keepAllToolCalls === "boolean" ? obj.keepAllToolCalls : fallback.keepAllToolCalls,
    fullTurnWindow: clampInt(obj.fullTurnWindow, fallback.fullTurnWindow),
    toolTailLines: clampInt(obj.toolTailLines, fallback.toolTailLines, 1),
  };
}

/** Tolerant parse of a PATCH (partial overrides) document: only fields
 * actually present and well-typed survive; everything else is omitted (never
 * defaulted — that would turn a partial patch into a silent full reset). */
export function parseContextDietOverrides(raw: unknown): ContextDietOverrides {
  const obj = isRecord(raw) ? raw : {};
  const out: ContextDietOverrides = {};
  if (typeof obj.preset === "boolean") (out as { preset: boolean }).preset = obj.preset;
  if (typeof obj.keepAllToolCalls === "boolean") (out as { keepAllToolCalls: boolean }).keepAllToolCalls = obj.keepAllToolCalls;
  if (typeof obj.fullTurnWindow === "number" && Number.isFinite(obj.fullTurnWindow) && obj.fullTurnWindow >= 0) {
    (out as { fullTurnWindow: number }).fullTurnWindow = Math.floor(obj.fullTurnWindow);
  }
  if (typeof obj.toolTailLines === "number" && Number.isFinite(obj.toolTailLines) && obj.toolTailLines >= 1) {
    (out as { toolTailLines: number }).toolTailLines = Math.floor(obj.toolTailLines);
  }
  return out;
}

/** Layer a partial override onto a base policy — used to merge workspace
 * global + per-room overrides into one effective policy. */
export function mergeContextDietPolicy(base: ContextDietPolicy, overrides: ContextDietOverrides): ContextDietPolicy {
  return {
    preset: overrides.preset ?? base.preset,
    keepAllToolCalls: overrides.keepAllToolCalls ?? base.keepAllToolCalls,
    fullTurnWindow: overrides.fullTurnWindow ?? base.fullTurnWindow,
    toolTailLines: overrides.toolTailLines ?? base.toolTailLines,
  };
}
