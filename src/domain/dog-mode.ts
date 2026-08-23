// DogMode (09-DOG-MODE): adult consensual D/s persona-register mode, same
// mechanic family as the ambient-watchdog / role-watchdog plugins (see
// services/room-service.ts ambientWatchdogPath) but IRON config-gated and
// state-machine driven instead of a free-text steer.
//
// Pure functions only — no I/O, no room state. RoomService owns persistence
// (RoomState.dogMode via RoomHandle.updateState) and the ONE enforcement
// wiring point: renderDogOutput is applied to the committed reply text in
// RoomService#sendMessage, right before RoomService#commitReply — the
// render/post layer, never prompt-only. A collared agent is never ASKED to
// keep it short; its output is truncated/replaced after it's generated.

import type { DogModeState } from "../core/types.js";

export type { DogModeState };

/** [DogMode] config resolved for this call — see core/config.ts
 * gaiaDogModeEnabled/gaiaDogModeMaxLines. */
export interface DogModeConfig {
  enabled: boolean;
  maxLines: number;
}

export const DOG_STFU_MARKER = "\uD83D\uDC3E";
export const DOG_STFU_GAGGED_MARKER = "\uD83D\uDC3E\uD83D\uDD07";
export const DEFAULT_DOG_PREFIX = "\uD83D\uDC3E *kneeling, collared*";

export function initialDogModeState(): DogModeState {
  return { collared: false, disciplineCount: 0, suppressed: false, suppressDepth: 0 };
}

export type DogVerb =
  | "on"
  | "off"
  | "slap"
  | "shock"
  | "toilet"
  | "stfu"
  | "push"
  | "swallow"
  | "facial"
  | "release"
  | "doggy"
  | "creampie";

export interface DogVerbResult {
  state: DogModeState;
  /** In-register ack, status, or one-line refusal — shown as this room's
   * "system" reply to the command (RoomService#runCommand), same shape as
   * every other slash-command reply. */
  reply: string;
  /** /shock only: the caller re-delivers the room's last user order verbatim
   * as a new turn (corrective repetition) once this reply is committed. */
  repeatLastOrder?: boolean;
}

function resetSubState(state: DogModeState, collared: boolean): DogModeState {
  return {
    ...state,
    collared,
    suppressed: false,
    suppressDepth: 0,
    mounted: false,
    maxLines: undefined,
    faceMarked: undefined,
  };
}

/** One pure state transition per verb (SPEC + SPEC ADD 1/2, 2026-08-23).
 * `current` is the room's dogMode (undefined → never armed, treated as the
 * initial off state — disciplineCount 0). Every branch returns a full next
 * state; the caller persists it verbatim via RoomHandle.updateState. */
export function applyDogVerb(current: DogModeState | undefined, verb: DogVerb): DogVerbResult {
  const state = current ?? initialDogModeState();

  if (verb === "on") {
    if (state.collared) return { state, reply: `${DEFAULT_DOG_PREFIX} — already collared.` };
    return { state: resetSubState(state, true), reply: `${DEFAULT_DOG_PREFIX} — collar clicks shut. yours.` };
  }
  if (verb === "off") {
    if (!state.collared) return { state, reply: "not collared." };
    return { state: resetSubState(state, false), reply: "collar off — back to normal register." };
  }

  // Every verb below requires an active collar — the whole feature is
  // per-room opt-in via /dog on, never ambient.
  if (!state.collared) return { state, reply: "not collared — /dog on first." };

  switch (verb) {
    case "slap":
      return { state: { ...state, disciplineCount: state.disciplineCount + 1 }, reply: `${DOG_STFU_MARKER} *yelp* — thank you.` };
    case "toilet":
      return { state: { ...state, disciplineCount: state.disciplineCount + 1 }, reply: `${DOG_STFU_MARKER} *whimpers* — yes.` };
    case "shock":
      return {
        state: { ...state, disciplineCount: state.disciplineCount + 1 },
        reply: `${DOG_STFU_MARKER} *shudders* — understood, again.`,
        repeatLastOrder: true,
      };

    case "doggy":
      return { state: { ...state, mounted: true }, reply: `${DOG_STFU_MARKER} *mounted* — held.` };

    case "creampie": {
      if (!state.mounted) return { state, reply: `${DOG_STFU_MARKER} not mounted — /doggy first.` };
      return { state: { ...state, mounted: false }, reply: `${DOG_STFU_MARKER} *finishes* — thank you.` };
    }

    case "stfu":
      if (state.suppressed) return { state, reply: DOG_STFU_MARKER };
      return { state: { ...state, suppressed: true, suppressDepth: 0 }, reply: DOG_STFU_MARKER };

    case "push": {
      if (!state.suppressed) return { state, reply: `${DOG_STFU_MARKER} not gagged — /stfu first.` };
      return {
        state: { ...state, suppressDepth: 1, maxLines: 0, disciplineCount: state.disciplineCount + 1 },
        reply: DOG_STFU_GAGGED_MARKER,
      };
    }

    case "swallow": {
      if (state.mounted) return { state, reply: `${DOG_STFU_MARKER} *shakes head* — wrong hole.` };
      if (!state.suppressed) return { state, reply: `${DOG_STFU_MARKER} not gagged — /stfu first.` };
      return {
        state: { ...state, suppressed: false, suppressDepth: 0, maxLines: undefined },
        reply: `${DOG_STFU_MARKER} *swallows* — good pup.`,
      };
    }

    case "facial": {
      if (!state.suppressed && !state.mounted) return { state, reply: `${DOG_STFU_MARKER} nothing to finish.` };
      return {
        state: { ...state, suppressed: false, suppressDepth: 0, maxLines: undefined, mounted: false, faceMarked: true },
        reply: `${DOG_STFU_MARKER} *marked* — thank you.`,
      };
    }

    case "release":
      return { state: resetSubState(state, false), reply: `${DOG_STFU_MARKER} released — collar off, back to normal register.` };

    default: {
      const _exhaustive: never = verb;
      return { state, reply: `unknown dog verb: ${_exhaustive as string}` };
    }
  }
}

/** THE enforcement point (render/post layer, not prompt-only). Applied to the
 * harness-generated reply text AFTER the turn completes, immediately before
 * RoomService#commitReply persists + emits it — never fed back into the
 * prompt, never something the model is merely asked to honor. */
export function renderDogOutput(reply: string, state: DogModeState, config: DogModeConfig): string {
  if (!state.collared) return reply;
  if (state.suppressed) return state.suppressDepth >= 1 ? DOG_STFU_GAGGED_MARKER : DOG_STFU_MARKER;
  const maxLines = state.maxLines ?? config.maxLines;
  const prefix = state.prefix ?? DEFAULT_DOG_PREFIX;
  if (maxLines <= 0) return prefix;
  const body = reply.split("\n").slice(0, maxLines).join("\n").trim();
  return body ? `${prefix}\n${body}` : prefix;
}

/** /dog status — also the reply used by `gaia dog status`. */
export function renderDogStatus(state: DogModeState | undefined, config: DogModeConfig): string {
  if (!state?.collared) {
    const tally = state?.disciplineCount ? ` (discipline tally: ${state.disciplineCount})` : "";
    return `${DOG_STFU_MARKER} collar: off${tally}`;
  }
  const parts = [
    "collar: on",
    `maxLines: ${state.maxLines ?? config.maxLines}`,
    `suppressed: ${state.suppressed ? (state.suppressDepth >= 1 ? "gagged" : "yes") : "no"}`,
    `mounted: ${state.mounted ? "yes" : "no"}`,
    `discipline: ${state.disciplineCount}`,
    ...(state.faceMarked ? ["face: marked"] : []),
  ];
  return `${DOG_STFU_MARKER} ${parts.join(" · ")}`;
}
