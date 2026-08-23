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
 * gaiaDogModeMaxLines. No `enabled` field: /dog on|off has no config gate. */
export interface DogModeConfig {
  maxLines: number;
}

export const DOG_STFU_MARKER = "\uD83D\uDC3E";
/** No longer emitted by any suppressed ack/render path (SPEC ADD below
 * replaced both with DOG_STFU_SOUNDS/DOG_PUSH_SOUNDS) — kept exported only
 * because it's a stable, recognizable "gagged" sentinel a caller could still
 * want to detect. */
export const DOG_STFU_GAGGED_MARKER = "\uD83D\uDC3E\uD83D\uDD07";
export const DEFAULT_DOG_PREFIX = "\uD83D\uDC3E *kneeling, collared*";

/** SPEC ADD (Pascal, 2026-08-23): suppressed-state acks are randomized
 * muffled SFX in game register, never the bare 🐾 marker alone. One pool per
 * sub-state; pickDogSound() is the only call site that touches Math.random
 * so every other function here stays pure-in-spirit and testable by pool
 * membership. Never hardcode a single string at a suppressed-ack call site
 * — always route through one of these pools + pickDogSound(). */
export const DOG_STFU_SOUNDS = ["\u3093\u3063\u2026", "\u3093\u3080\u30fc\u3063", "\u3058\u3085\u3063\u2026\u3093\u3063", "\u3054\u304f\u2026\u3063", "\u3093\u3050\u3063", "\u306f\u3041\u2026\u3093\u3063"] as const;
export const DOG_PUSH_SOUNDS = [
  "\u3093\u3050\u3063\u2026\u3093\u3093\u3063\u2026\uD83D\uDC3E",
  "\u3093\u30fc\u3063\u2026\u3093\u3050\u3063\u2026\uD83D\uDC3E",
  "\u3093\u3063\u2026\u3093\u3080\u3063\u2026\uD83D\uDC3E",
  "\u3050\u3077\u3063\u2026\u3093\u3093\u30fc\u3063\u2026\uD83D\uDC3E",
  "\u3093\u3093\u3063\u2026\u3058\u3085\u3077\u3063\u2026\uD83D\uDC3E",
  "\u306f\u3041\u3063\u2026\u3093\u3050\u3045\u2026\uD83D\uDC3E",
] as const;
export const DOG_SWALLOW_ACKS = [
  "\u3054\u304f\u3093\u2026\u3054\u304f\u2026\u306f\u3041\u2026\uD83D\uDC3E — good pup.",
  "\u3093\u304f\u3063\u2026\u3054\u304f\u3093\u2026\u306f\u3041\u2026\uD83D\uDC3E — good pup.",
  "\u3054\u304f\u2026\u3054\u304f\u3063\u2026\u3075\u3045\u2026\uD83D\uDC3E — good pup.",
  "\u3093\u3063\u2026\u3054\u304f\u3093\u2026\u306f\u3041\u3041\u2026\uD83D\uDC3E — good pup.",
  "\u3054\u304f\u308a\u2026\u306f\u3041\u2026\uD83D\uDC3E — good pup, all gone.",
  "\u3093\u30fc\u2026\u3054\u304f\u3093\u2026\uD83D\uDC3E — good pup, swallowed.",
] as const;
export const DOG_FACIAL_ACKS = [
  "\u3073\u3061\u3083\u3063\u2026\uD83D\uDC3E *marked* — thank you.",
  "\u305f\u3089\u3063\u2026\uD83D\uDC3E *marked* — thank you.",
  "\u3074\u3061\u3083\u2026\u3093\u3063\u2026\uD83D\uDC3E *marked* — thank you.",
  "\u3068\u308d\u3063\u2026\uD83D\uDC3E *marked* — thank you.",
  "\u3079\u3061\u3083\u3063\u2026\u306f\u3041\u2026\uD83D\uDC3E *marked* — thank you.",
  "\u3064\u3045\u2026\uD83D\uDC3E *marked* — thank you.",
] as const;
// SPEC CHANGE (Pascal, whip 338, 2026-08-23): English register, not the
// Japanese onomatopoeia style of the other pools above — /shock's yelp is
// the whole reply now (no re-delivery mechanic, see applyDogVerb below).
export const DOG_SHOCK_YELPS = ["*YELP\u2014*\u26a1", "*yelp!*\u26a1", "*whimper*\u26a1", "*YIPE\u2014*\u26a1", "*whines, flinching*\u26a1", "*sharp yelp*\u26a1"] as const;

/** ONLY call site for Math.random in this module (SPEC ADD sound pools
 * above) — every ack/render call routes a pool through here, never a
 * hardcoded single string. Falls back to pool[0] if somehow given []. */
function pickDogSound(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0];
}

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
    // SPEC CHANGE (Pascal, whip 338, 2026-08-23): NO re-delivery/echo of the
    // last user order — that parrot behavior is banned. /shock is yelp SFX
    // only + the discipline counter, nothing else.
    case "shock":
      return { state: { ...state, disciplineCount: state.disciplineCount + 1 }, reply: pickDogSound(DOG_SHOCK_YELPS) };

    case "doggy":
      return { state: { ...state, mounted: true }, reply: `${DOG_STFU_MARKER} *mounted* — held.` };

    case "creampie": {
      if (!state.mounted) return { state, reply: `${DOG_STFU_MARKER} not mounted — /doggy first.` };
      return { state: { ...state, mounted: false }, reply: `${DOG_STFU_MARKER} *finishes* — thank you.` };
    }

    case "stfu":
      if (state.suppressed) return { state, reply: pickDogSound(DOG_STFU_SOUNDS) };
      return { state: { ...state, suppressed: true, suppressDepth: 0 }, reply: pickDogSound(DOG_STFU_SOUNDS) };

    case "push": {
      if (!state.suppressed) return { state, reply: `${DOG_STFU_MARKER} not gagged — /stfu first.` };
      return {
        state: { ...state, suppressDepth: 1, maxLines: 0, disciplineCount: state.disciplineCount + 1 },
        reply: pickDogSound(DOG_PUSH_SOUNDS),
      };
    }

    case "swallow": {
      if (state.mounted) return { state, reply: `${DOG_STFU_MARKER} *shakes head* — wrong hole.` };
      if (!state.suppressed) return { state, reply: `${DOG_STFU_MARKER} not gagged — /stfu first.` };
      return {
        state: { ...state, suppressed: false, suppressDepth: 0, maxLines: undefined },
        reply: pickDogSound(DOG_SWALLOW_ACKS),
      };
    }

    case "facial": {
      if (!state.suppressed && !state.mounted) return { state, reply: `${DOG_STFU_MARKER} nothing to finish.` };
      return {
        state: { ...state, suppressed: false, suppressDepth: 0, maxLines: undefined, mounted: false, faceMarked: true },
        reply: pickDogSound(DOG_FACIAL_ACKS),
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
  if (state.suppressed) return pickDogSound(state.suppressDepth >= 1 ? DOG_PUSH_SOUNDS : DOG_STFU_SOUNDS);
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
