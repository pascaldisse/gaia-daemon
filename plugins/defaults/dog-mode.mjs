// DogMode — bundled default command plugin (09-DOG-MODE: adult consensual
// D/s persona-register). Same plugin API/shape as ~/.gaia/plugins/whip.mjs
// (services/plugins.ts CommandPlugin) but shipped as an install DEFAULT (see
// plugins.ts bundledCommandPluginsDir) so it works identically with zero
// manual setup, unlike a user-dropped plugin.
//
// One plugin OWNS every DogMode command name (`command` is an array — see
// plugins.ts pluginStateKey/`id`): the collar master switch /dog on|off|
// status|toggle, plus the discipline/state verbs /slap /shock /toilet /stfu
// /push /swallow /facial /release /doggy /creampie. All share ONE state
// bucket (RoomState.pluginState.dog).
//
// SPEC HISTORY: whips 344-346 (2026-08-23) — every verb but on/off/status is
// a PURE STATE TRANSITION, zero synthesized reply text of any kind; the verb
// is always delivered to the room's agent as a REAL message turn
// (`rewriteAsMessage`) so only the agent's own generated words are ever
// shown as its speech. Whip 348 — extracted out of gaia-daemon core into this
// plugin (core keeps only the generic hooks: PluginResult.rewriteAsMessage,
// CommandPlugin.renderCap, CommandPlugin.turnStart, multi-command `command`
// arrays). Whip 349 — the injected "🐾 *kneeling, collared*" PREFIX inside the
// agent's own displayed text is a banned placeholder (words the agent never
// wrote) — renderCap is `{maxLines}` ONLY, no prefix, ever. The collar
// reminder people still want lives instead as a SYSTEM-authored chrome line
// (`renderCap.note`, mirroring how a plain plugin `reply` is system text),
// synthesized fresh at every display next to the (possibly capped) agent
// reply — never merged into it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MARK = "\uD83D\uDC3E";
const DOG_VERBS = ["dog", "slap", "shock", "toilet", "stfu", "push", "swallow", "facial", "release", "doggy", "creampie"];

function initialState() {
  return { collared: false, disciplineCount: 0, suppressed: false, suppressDepth: 0 };
}

/** Defensive coercion of whatever's sitting in RoomState.pluginState.dog —
 * core's generic pluginState sanitizer (domain/rooms.ts pluginStateFrom)
 * bounds size/depth but knows nothing about THIS shape, so the plugin owns
 * its own validation, every time it reads state (mirrors the old
 * domain/dog-mode.ts#dogModeFrom, now plugin-local). Garbage/partial input
 * never crashes — it just resolves to sane defaults. */
function normalizeState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const collared = r.collared === true;
  const suppressed = r.suppressed === true;
  const suppressDepth = r.suppressDepth === 1 ? 1 : 0;
  const mounted = r.mounted === true;
  const faceMarked = r.faceMarked === true;
  const disciplineCount =
    typeof r.disciplineCount === "number" && Number.isFinite(r.disciplineCount) && r.disciplineCount >= 0 ? Math.floor(r.disciplineCount) : 0;
  const maxLines = typeof r.maxLines === "number" && Number.isSafeInteger(r.maxLines) && r.maxLines >= 0 ? r.maxLines : undefined;
  return {
    collared,
    disciplineCount,
    suppressed,
    suppressDepth,
    ...(mounted ? { mounted: true } : {}),
    ...(faceMarked ? { faceMarked: true } : {}),
    ...(maxLines !== undefined ? { maxLines } : {}),
  };
}

function resetSubState(state, collared) {
  return { ...state, collared, suppressed: false, suppressDepth: 0 };
}

/** /dog on|off — the only verbs with a synthesized reply, and even then it's
 * plain SYSTEM status text ("collar clicks shut. yours.", "collar off — back
 * to normal register.", "already collared.", "not collared."), never
 * attributed to the agent as its own speech (same authorship as any other
 * plugin's plain `reply`, e.g. whip's "nothing to do" note). */
function applyDogVerb(state, verb) {
  if (verb === "on") {
    if (state.collared) return { state, reply: `${MARK} *kneeling, collared* — already collared.` };
    return { state: resetSubState(state, true), reply: `${MARK} *kneeling, collared* — collar clicks shut. yours.` };
  }
  if (!state.collared) return { state, reply: "not collared." };
  return { state: resetSubState(state, false), reply: "collar off — back to normal register." };
}

/** Pure per-room state transform for every DogMode verb except on/off/status
 * — returns the NEXT STATE ONLY, no reply text of any kind. An invalid
 * precondition (e.g. /creampie with nothing mounted) is simply a no-op: this
 * never blocks or explains anything, only keeps the state machine
 * consistent. The verb is ALWAYS delivered to the room's agent as a real
 * message turn regardless of what this returns (see default export's
 * `run()`) — whatever the agent actually says is its own generated speech,
 * subject only to the mechanical `renderCap` below, never something
 * synthesized here. */
function applyDiscipline(state, verb) {
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
      // Full silence: MaxLines forced to 0 (render layer shows nothing).
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
    default:
      return state;
  }
}

/** /dog status — plain, system, describes state, never the agent's own
 * speech. */
function renderStatus(state, maxLinesDefault) {
  if (!state.collared) {
    const tally = state.disciplineCount ? ` (discipline tally: ${state.disciplineCount})` : "";
    return `${MARK} collar: off${tally}`;
  }
  const parts = [
    "collar: on",
    `maxLines: ${state.maxLines ?? maxLinesDefault}`,
    `suppressed: ${state.suppressed ? (state.suppressDepth >= 1 ? "gagged" : "yes") : "no"}`,
    `mounted: ${state.mounted ? "yes" : "no"}`,
    `discipline: ${state.disciplineCount}`,
    ...(state.faceMarked ? ["face: marked"] : []),
  ];
  return `${MARK} ${parts.join(" \u00b7 ")}`;
}

/** SYSTEM-authored chrome line shown alongside a capped reply (renderCap.note
 * — see plugins.ts PluginRenderCap). Never part of the agent's own text. */
function collarNote(state, maxLines) {
  const gag = state.suppressed ? (state.suppressDepth >= 1 ? " (gagged)" : " (suppressed)") : "";
  if (maxLines <= 0) return `${MARK} collared — response silenced${gag}.`;
  return `${MARK} collared — display capped to ${maxLines} line${maxLines === 1 ? "" : "s"}${gag}.`;
}

/** [DogMode] MaxLines resolution: GAIA_DOGMODE_MAXLINES env overrides; then
 * `<workspaceRoot>/.gaia/config.json`'s `{ dogMode: { maxLines } }`; then 2.
 * A room's own maxLines override (set by /push, cleared by /swallow|
 * /release) wins over all of this — see normalizeState/applyDiscipline.
 * /dog on|off itself has NO config gate anywhere — this is the only DogMode
 * config knob; a stale `dogMode.enabled` key in an old config.json is simply
 * ignored (never read below). */
function maxLinesFor(ctx) {
  const envRaw = Number.parseInt(process.env.GAIA_DOGMODE_MAXLINES ?? "", 10);
  if (Number.isSafeInteger(envRaw) && envRaw >= 0) return envRaw;
  try {
    const raw = JSON.parse(readFileSync(join(ctx.workspaceRoot, ".gaia", "config.json"), "utf8"));
    const section = raw && typeof raw === "object" ? raw.dogMode : undefined;
    const m = section && typeof section === "object" ? section.maxLines : undefined;
    if (typeof m === "number" && Number.isSafeInteger(m) && m >= 0) return m;
  } catch {}
  return 2;
}

function agentFor(workspaceRoot, roomId) {
  try {
    const s = JSON.parse(readFileSync(join(workspaceRoot, ".gaia", "rooms", roomId, "state.json"), "utf8"));
    if (typeof s.activeAgent === "string" && s.activeAgent) return s.activeAgent;
  } catch {}
  // Brand-new room: this verb can be the room's very first event, fired
  // before any agent turn has ever run — state.json's activeAgent isn't
  // written yet. Mirror the same fallback room-service.ts itself uses
  // (state.activeAgent ?? workspace.config.defaultAgent).
  try {
    const c = JSON.parse(readFileSync(join(workspaceRoot, ".gaia", "config.json"), "utf8"));
    if (typeof c.defaultAgent === "string" && c.defaultAgent) return c.defaultAgent;
  } catch {}
  return "unknown";
}

export default {
  command: DOG_VERBS,
  id: "dog",
  description:
    "DogMode persona-register (09-DOG-MODE, adult consensual D/s): /dog on|off|status (bare /dog toggles), plus discipline verbs /slap /shock /toilet /stfu /push /swallow /facial /release /doggy /creampie — every verb is delivered to the room's agent as a real turn",
  run(args, ctx) {
    const state = normalizeState(ctx.state);
    if (ctx.command === "dog") {
      const first = args[0]?.toLowerCase();
      if (first === undefined) {
        const { state: next, reply } = applyDogVerb(state, state.collared ? "off" : "on");
        return { state: next, reply };
      }
      if (first === "on" || first === "off") {
        const { state: next, reply } = applyDogVerb(state, first);
        return { state: next, reply };
      }
      // "status", or any garbage sub — reports only, never mutates.
      return { reply: renderStatus(state, maxLinesFor(ctx)) };
    }
    // Every other DogMode verb: pure state transition, delivered to the
    // room's agent as a REAL message turn (see module doc above).
    const next = applyDiscipline(state, ctx.command);
    const target = agentFor(ctx.workspaceRoot, ctx.roomId);
    return { state: next, rewriteAsMessage: true, targets: [target] };
  },
  renderCap(ctx) {
    const state = normalizeState(ctx.state);
    if (!state.collared) return undefined;
    const maxLines = state.maxLines ?? maxLinesFor(ctx);
    return { maxLines, note: collarNote(state, maxLines) };
  },
  prompt(ctx) {
    // While suppressed (/stfu, deepened by /push), a one-line context hint
    // tells the agent to answer with sounds only — never fed as fabricated
    // reply text, just a nudge; the mechanical MaxLines cap in `renderCap`
    // enforces the actual limit regardless of what the agent chooses to say.
    const state = normalizeState(ctx.state);
    if (!state.collared || !state.suppressed) return undefined;
    return `${MARK} DogMode: you are suppressed/gagged right now — respond with sounds only (whimpers, yelps), no words.`;
  },
  turnStart(ctx) {
    // A /facial marker is visible in status only through the room's NEXT
    // agent turn — clear it now, at that turn's start, never mid-command
    // (applyDiscipline never touches this).
    const state = normalizeState(ctx.state);
    if (!state.faceMarked) return undefined;
    const { faceMarked, ...rest } = state;
    return rest;
  },
};
