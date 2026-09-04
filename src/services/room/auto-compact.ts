import type { AutoCompactConfig, RoomAutoCompactState } from "../../core/types.js";

/** Configuration defaults: disabled unless a workspace or room opts in. */
const DEFAULT_AUTO_COMPACT: AutoCompactConfig = { thresholdPct: null, cooldownTurns: 1 };

export interface ContextUsageProvider {
  usageFor(agentId: string): { usedTokens: number; maxTokens?: number } | undefined;
}

export interface AutoCompactDecision {
  state: RoomAutoCompactState;
  /** Integer percentage reported in the durable system line. */
  scheduledPct?: number;
}

/** Room values override the workspace defaults field-by-field. */
export function resolveAutoCompactConfig(workspace: AutoCompactConfig | undefined, room?: RoomAutoCompactState): AutoCompactConfig {
  const base = workspace ?? DEFAULT_AUTO_COMPACT;
  return {
    thresholdPct: room?.thresholdPct === undefined ? base.thresholdPct : room.thresholdPct,
    cooldownTurns: room?.cooldownTurns === undefined ? base.cooldownTurns : room.cooldownTurns,
  };
}

/**
 * Evaluate one completed agent turn. The returned state is deliberately pure so
 * room persistence and tests can supply independent state/usage providers.
 */
export function scheduleAutoCompactAfterTurn(
  config: AutoCompactConfig,
  previous: RoomAutoCompactState | undefined,
  agentId: string,
  usageProvider: ContextUsageProvider,
): AutoCompactDecision {
  const state: RoomAutoCompactState = {
    ...(previous?.thresholdPct === undefined ? {} : { thresholdPct: previous.thresholdPct }),
    ...(previous?.cooldownTurns === undefined ? {} : { cooldownTurns: previous.cooldownTurns }),
    ...(previous?.pending ? { pending: { ...previous.pending } } : {}),
    ...(previous?.cooldowns ? { cooldowns: { ...previous.cooldowns } } : {}),
  };
  const remaining = state.cooldowns?.[agentId] ?? 0;
  if (remaining > 0) {
    state.cooldowns![agentId] = remaining - 1;
    return { state };
  }
  if (config.thresholdPct === null || state.pending?.[agentId] !== undefined) return { state };
  const usage = usageProvider.usageFor(agentId);
  if (!usage?.maxTokens || usage.maxTokens <= 0) return { state };
  const exactPct = (usage.usedTokens / usage.maxTokens) * 100;
  if (exactPct < config.thresholdPct) return { state };
  const scheduledPct = Math.floor(exactPct);
  state.pending = { ...state.pending, [agentId]: scheduledPct };
  state.cooldowns = { ...state.cooldowns, [agentId]: config.cooldownTurns };
  return { state, scheduledPct };
}

/** Consume a pending pass immediately before the agent's next turn. */
export function takePendingAutoCompact(state: RoomAutoCompactState | undefined, agentId: string): { state: RoomAutoCompactState; pct?: number } {
  const pending = state?.pending?.[agentId];
  const next: RoomAutoCompactState = {
    ...(state?.thresholdPct === undefined ? {} : { thresholdPct: state.thresholdPct }),
    ...(state?.cooldownTurns === undefined ? {} : { cooldownTurns: state.cooldownTurns }),
    ...(state?.pending ? { pending: { ...state.pending } } : {}),
    ...(state?.cooldowns ? { cooldowns: { ...state.cooldowns } } : {}),
  };
  if (pending !== undefined) delete next.pending![agentId];
  return { state: next, ...(pending === undefined ? {} : { pct: pending }) };
}
