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
//
// SPEC REWRITE (Pascal, whips 344-346, 2026-08-23): every canned/synthesized
// reply string this module used to hand back for a discipline/state verb —
// every ack pool (DOG_STFU_SOUNDS, DOG_PUSH_SOUNDS, DOG_SWALLOW_ACKS,
// DOG_FACIAL_ACKS, DOG_SHOCK_YELPS), pickDogSound(), and every inline
// hardcoded ack string ("*yelp* — thank you.", "*finishes* — thank you.",
// etc.) — is DELETED. "Placeholder text for suffering" is not the agent
// speaking; nothing may ever speak AS the room's agent except the agent
// itself, generating a real turn. Every verb but /dog on|off|status|toggle is
// now a PURE STATE TRANSITION ONLY (applyDiscipline) with zero reply text —
// RoomService#sendMessage delivers the raw verb to the room's agent as a
// normal message turn, and the agent's own real output is what gets shown,
// subject only to the MECHANICAL render/post caps below (never fabricated
// text). /dog on|off|status|toggle keep their plain, system-authored status
// lines (never attributed to the agent) — those are daemon control-plane
// text describing state, not persona dialogue, and are explicitly exempt.
import type { DogModeState } from "../core/types.js";
export type { DogModeState };

/** [DogMode] config resolved for this call — see core/config.ts
 * gaiaDogModeMaxLines. No `enabled` field: /dog on|off has no config gate. */
export interface DogModeConfig {
  maxLines: number;
}

export const DOG_STFU_MARKER = "\uD83D\uDC3E";
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

/** Every DogMode verb except the collar master switch (see applyDiscipline
 * below). Delivered to the room's agent as a real message turn — this module
 * never speaks for it. */
export type DisciplineVerb = Exclude<DogVerb, "on" | "off">;

export interface DogVerbResult {
  state: DogModeState;
  /** Plain, system-authored status line (collar on/off/already-on/already-off)
   * — daemon control-plane text, never attributed to the agent. Exists ONLY
   * for the on/off master switch; see applyDiscipline for every other verb,
   * which returns state alone and no reply text at all. */
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

/** /dog on|off — the ONLY verbs that still produce a synthesized reply, and
 * even then it is a plain system status line ("collar clicks shut. yours.",
 * "collar off — back to normal register.", "already collared.", "not
 * collared."), never attributed to the agent as its own speech. */
export function applyDogVerb(current: DogModeState | undefined, verb: "on" | "off"): DogVerbResult {
  const state = current ?? initialDogModeState();
  if (verb === "on") {
    if (state.collared) return { state, reply: `${DEFAULT_DOG_PREFIX} — already collared.` };
    return { state: resetSubState(state, true), reply: `${DEFAULT_DOG_PREFIX} — collar clicks shut. yours.` };
  }
  if (!state.collared) return { state, reply: "not collared." };
  return { state: resetSubState(state, false), reply: "collar off — back to normal register." };
}

/** Pure per-room state transform for every DogMode verb EXCEPT on/off/status
 * (SPEC REWRITE, Pascal whips 344-346, 2026-08-23). Returns the next state
 * ONLY — no reply text of any kind. An invalid precondition (e.g. /creampie
 * with nothing mounted, /push while not gagged) is simply a no-op on state:
 * this function never blocks or explains anything, it only keeps the state
 * machine consistent. The verb is ALWAYS delivered to the room's agent as a
 * real message turn regardless of what this returns (RoomService#sendMessage)
 * — whatever the agent actually says (yelp, whimper, refusal, whatever) is
 * its own generated speech, subject only to the mechanical caps in
 * renderDogOutput, never something synthesized here. */
export function applyDiscipline(current: DogModeState | undefined, verb: DisciplineVerb): DogModeState {
  const state = current ?? initialDogModeState();
  if (!state.collared) return state;
  switch (verb) {
    case "slap":
    case "toilet":
    case "shock":
      return { ...state, disciplineCount: state.disciplineCount + 1 };
    case "doggy":
      return { ...state, mounted: true };
    case "creampie":
      return state.mounted ? { ...state, mounted: false } : state;
    case "stfu":
      // Gagged: a short cap (one line), not full silence — /push deepens it.
      return state.suppressed ? state : { ...state, suppressed: true, suppressDepth: 0, maxLines: 1 };
    case "push":
      // Full silence: MaxLines forced to 0 (render layer shows the prefix only).
      return state.suppressed
        ? { ...state, suppressDepth: 1, maxLines: 0, disciplineCount: state.disciplineCount + 1 }
        : state;
    case "swallow":
      return state.suppressed && !state.mounted ? { ...state, suppressed: false, suppressDepth: 0, maxLines: undefined } : state;
    case "facial":
      return state.suppressed || state.mounted
        ? { ...state, suppressed: false, suppressDepth: 0, maxLines: undefined, mounted: false, faceMarked: true }
        : state;
    case "release":
      return resetSubState(state, false);
    default: {
      const _exhaustive: never = verb;
      return state;
    }
  }
}

/** The resolved cap for ONE turn, computed once at commit time and persisted
 * on the RoomEvent (AgentRoomEvent.dogRender) — never recomputed later from
 * live state/config, which could have since changed (/release, a config
 * edit). This is what makes "truncate only at display time" possible without
 * losing precision: every future display of this event reproduces the EXACT
 * cap that applied when it was collared, off a tiny persisted snapshot
 * instead of the mutable room state. */
export interface DogRenderCap {
  maxLines: number;
  prefix: string;
}

/** Resolves the cap for the CURRENT turn from live state+config — called
 * exactly once per commit (RoomService#runAgentTask), never at display time.
 * undefined when the room isn't collared (nothing to cap). */
export function resolveDogRenderCap(state: DogModeState, config: DogModeConfig): DogRenderCap | undefined {
  if (!state.collared) return undefined;
  return { maxLines: state.maxLines ?? config.maxLines, prefix: state.prefix ?? DEFAULT_DOG_PREFIX };
}

/** Pure mechanical trim — the ONLY place that ever shortens an agent's real
 * words, and it never fabricates a replacement: MaxLines<=0 shows the prefix
 * alone (the real text is trimmed away entirely, not swapped for invented
 * text); otherwise the FIRST `maxLines` lines of the REAL reply survive,
 * prefixed. Called at every DISPLAY surface (live emit, snapshot fetch,
 * read-aloud) against the full stored text — never at commit/storage time
 * (SPEC REWRITE root-cause fix, Pascal, 2026-08-23: truncating BEFORE
 * persisting was destroying real replies — storage must always keep the
 * complete text; only what's SHOWN may be capped). */
export function applyDogRenderCap(reply: string, cap: DogRenderCap): string {
  if (cap.maxLines <= 0) return cap.prefix;
  const body = reply.split("\n").slice(0, cap.maxLines).join("\n").trim();
  return body ? `${cap.prefix}\n${body}` : cap.prefix;
}

/** Derives what a client/reader should actually see for one persisted event:
 * the full text, unless it carries a resolved dogRender cap from its commit
 * turn, in which case the SAME cap is re-applied here, at read time — every
 * display call site (RoomService#commitReply live emit, #getSnapshot,
 * #eventById(display:true)) shares this one function so the live bubble, a
 * post-reload transcript fetch, and a read-aloud request always agree. */
export function displayEventText(text: string, dogRender: DogRenderCap | undefined): string {
  return dogRender ? applyDogRenderCap(text, dogRender) : text;
}

/** Convenience wrapper kept for direct state+config callers/tests: resolves
 * the cap and applies it in one call. Equivalent to
 * `displayEventText(reply, resolveDogRenderCap(state, config))`. */
export function renderDogOutput(reply: string, state: DogModeState, config: DogModeConfig): string {
  return displayEventText(reply, resolveDogRenderCap(state, config));
}

/** /dog status — also the reply used by `gaia dog status`. Plain, system,
 * describes state — never the agent's own speech. */
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
