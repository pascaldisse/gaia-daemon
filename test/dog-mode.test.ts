// 09-DOG-MODE: adult consensual D/s persona-register mode.
// Covers: parseCommand surface, config IRON gate precedence, the pure on/off
// collar switch (applyDogVerb) and the pure discipline/state-verb transform
// (applyDiscipline — SPEC REWRITE, Pascal whips 344-346, 2026-08-23: NO reply
// text of any kind for any verb but on/off, no ack pools, no pickDogSound),
// render/post-layer enforcement (renderDogOutput — mechanical MaxLines caps
// only, never a fabricated replacement string), and RoomState round-trip
// (normalizeRoomState).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../src/services/commands.js";
import { DEFAULTS, gaiaDogModeMaxLines, parseDogModeConfig } from "../src/core/config.js";
import {
  applyDogVerb,
  applyDiscipline,
  initialDogModeState,
  renderDogOutput,
  renderDogStatus,
  type DogModeConfig,
} from "../src/domain/dog-mode.js";
import { normalizeRoomState } from "../src/domain/rooms.js";
import { createTempDir } from "./helpers/temp.js";
const CFG: DogModeConfig = { maxLines: 2 };
async function writeConfig(cwd: string, config: unknown): Promise<void> {
  await mkdir(join(cwd, ".gaia"), { recursive: true });
  await writeFile(join(cwd, ".gaia", "config.json"), JSON.stringify(config), "utf8");
}
async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
// --- parseCommand ------------------------------------------------------------
test("parseCommand: /dog on|off|status, bare /dog is a toggle", () => {
  assert.deepEqual(parseCommand("/dog on"), { type: "dog", sub: "on" });
  assert.deepEqual(parseCommand("/dog off"), { type: "dog", sub: "off" });
  assert.deepEqual(parseCommand("/dog status"), { type: "dog", sub: "status" });
  assert.deepEqual(parseCommand("/dog"), { type: "dog", sub: "toggle" });
  assert.deepEqual(parseCommand("/dog garbage"), { type: "dog", sub: "status" });
});
test("parseCommand: every DogMode verb parses to its own bare type", () => {
  for (const name of ["slap", "shock", "toilet", "stfu", "push", "swallow", "facial", "release", "doggy", "creampie"]) {
    assert.deepEqual(parseCommand(`/${name}`), { type: name });
  }
});
// --- config: MaxLines precedence (enabled gate REMOVED 2026-08-23) ----------
test("DEFAULTS.dogMode: MaxLines 2, no enabled key", () => {
  assert.equal(DEFAULTS.dogMode.maxLines, 2);
  assert.equal((DEFAULTS.dogMode as Record<string, unknown>).enabled, undefined);
});
test("parseDogModeConfig: maxLines survives, junk/out-of-range drops, stale enabled key ignored harmlessly", () => {
  assert.deepEqual(parseDogModeConfig({ maxLines: 5 }), { maxLines: 5 });
  assert.deepEqual(parseDogModeConfig({ maxLines: 5, extra: "ignored" }), { maxLines: 5 });
  assert.equal(parseDogModeConfig({ maxLines: -1 }), undefined);
  // A stale `enabled` key from before the gate was removed drops silently,
  // same as any other unknown field — never resurrected, never an error.
  assert.equal(parseDogModeConfig({ enabled: true }), undefined);
  assert.deepEqual(parseDogModeConfig({ enabled: true, maxLines: 3 }), { maxLines: 3 });
  assert.equal(parseDogModeConfig({}), undefined);
  assert.equal(parseDogModeConfig(null), undefined);
});
test("gaiaDogModeMaxLines: no env, no config file -> DEFAULTS.maxLines (2)", async () => {
  const temp = await createTempDir("gaia-dogmode-cfg-");
  try {
    await withEnv({ GAIA_DOGMODE_MAXLINES: undefined }, () => {
      assert.equal(gaiaDogModeMaxLines(temp.path), 2);
    });
  } finally {
    await temp.cleanup();
  }
});
test("gaiaDogModeMaxLines: config.json dogMode section is the fallback (stale enabled key harmless)", async () => {
  const temp = await createTempDir("gaia-dogmode-cfg-");
  try {
    await writeConfig(temp.path, { dogMode: { enabled: true, maxLines: 4 } });
    await withEnv({ GAIA_DOGMODE_MAXLINES: undefined }, () => {
      assert.equal(gaiaDogModeMaxLines(temp.path), 4);
    });
  } finally {
    await temp.cleanup();
  }
});
test("gaiaDogModeMaxLines: env override wins over config.json", async () => {
  const temp = await createTempDir("gaia-dogmode-cfg-");
  try {
    await writeConfig(temp.path, { dogMode: { maxLines: 4 } });
    await withEnv({ GAIA_DOGMODE_MAXLINES: "0" }, () => {
      assert.equal(gaiaDogModeMaxLines(temp.path), 0);
    });
  } finally {
    await temp.cleanup();
  }
});
// --- state machine: on/off (the ONLY verbs with a synthesized, plain,
// system-authored reply — everything else below is state-only, no reply). ---
test("applyDogVerb: /dog on collars a fresh room; /dog off releases it", () => {
  const on = applyDogVerb(undefined, "on");
  assert.equal(on.state.collared, true);
  assert.equal(on.state.disciplineCount, 0);
  assert.equal(on.state.suppressed, false);
  assert.match(on.reply, /collar/i);
  const off = applyDogVerb(on.state, "off");
  assert.equal(off.state.collared, false);
  assert.equal(off.state.suppressed, false);
  assert.match(off.reply, /collar/i);
});
test("applyDogVerb: /dog on twice, /dog off twice — plain redundant-call replies, no crash", () => {
  const on = applyDogVerb(undefined, "on");
  const onAgain = applyDogVerb(on.state, "on");
  assert.equal(onAgain.state.collared, true);
  assert.match(onAgain.reply, /already collared/);
  const off = applyDogVerb(onAgain.state, "off");
  const offAgain = applyDogVerb(off.state, "off");
  assert.equal(offAgain.state.collared, false);
  assert.match(offAgain.reply, /not collared/);
});
test("applyDiscipline: disciplineCount is monotonic across off->on cycles (whip-count style)", () => {
  let state = applyDogVerb(undefined, "on").state;
  state = applyDiscipline(state, "slap");
  state = applyDiscipline(state, "slap");
  assert.equal(state.disciplineCount, 2);
  state = applyDogVerb(state, "off").state;
  assert.equal(state.disciplineCount, 2); // survives release
  state = applyDogVerb(state, "on").state;
  assert.equal(state.disciplineCount, 2); // survives re-collar
});
// --- SPEC REWRITE: applyDiscipline is state-only, NO reply text, ever -------
test("applyDiscipline: not collared -> every verb is a pure no-op on state (no reply field exists at all)", () => {
  for (const verb of ["slap", "shock", "toilet", "stfu", "push", "swallow", "facial", "doggy", "creampie", "release"] as const) {
    const result = applyDiscipline(undefined, verb);
    assert.equal(result.collared, false);
    assert.ok(!("reply" in result), "applyDiscipline must never return a reply field");
  }
});
test("applyDiscipline: /slap /toilet /shock are +1 tally, no sub-state change, no reply", () => {
  const collared = applyDogVerb(undefined, "on").state;
  for (const verb of ["slap", "toilet", "shock"] as const) {
    const result = applyDiscipline(collared, verb);
    assert.equal(result.disciplineCount, 1);
    assert.equal(result.suppressed, false);
    assert.ok(!("reply" in result));
  }
});
test("applyDiscipline: /stfu suppresses with MaxLines 1; /push only deepens while suppressed, forces MaxLines 0", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const pushTooEarly = applyDiscipline(collared, "push");
  assert.equal(pushTooEarly.suppressed, false); // no-op: not gagged yet
  assert.equal(pushTooEarly.maxLines, undefined);
  const stfu = applyDiscipline(collared, "stfu");
  assert.equal(stfu.suppressed, true);
  assert.equal(stfu.suppressDepth, 0);
  assert.equal(stfu.maxLines, 1);
  const stfuAgain = applyDiscipline(stfu, "stfu"); // idempotent, no crash
  assert.deepEqual(stfuAgain, stfu);
  const pushed = applyDiscipline(stfu, "push");
  assert.equal(pushed.suppressDepth, 1);
  assert.equal(pushed.maxLines, 0);
  assert.equal(pushed.disciplineCount, 1);
});
test("applyDiscipline: /swallow only valid while suppressed and NOT mounted; lifts suppression, restores MaxLines, collar stays", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const tooEarly = applyDiscipline(collared, "swallow");
  assert.equal(tooEarly.suppressed, false); // no-op: not gagged
  const stfu = applyDiscipline(collared, "stfu");
  const pushed = applyDiscipline(stfu, "push"); // maxLines forced 0
  const swallowed = applyDiscipline(pushed, "swallow");
  assert.equal(swallowed.suppressed, false);
  assert.equal(swallowed.suppressDepth, 0);
  assert.equal(swallowed.maxLines, undefined); // back to /dog register, not full release
  assert.equal(swallowed.collared, true);
  // While mounted, /swallow is a no-op even if also suppressed (wrong hole).
  const mountedAndSuppressed = applyDiscipline(applyDiscipline(collared, "doggy"), "stfu");
  const refused = applyDiscipline(mountedAndSuppressed, "swallow");
  assert.deepEqual(refused, mountedAndSuppressed); // unchanged
});
test("applyDiscipline: /facial valid while suppressed OR mounted; lifts whichever is active, sets faceMarked, collar stays", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const tooEarly = applyDiscipline(collared, "facial");
  assert.deepEqual(tooEarly, collared); // no-op: nothing to finish
  const viaStfu = applyDiscipline(applyDiscipline(collared, "stfu"), "facial");
  assert.equal(viaStfu.suppressed, false);
  assert.equal(viaStfu.faceMarked, true);
  assert.equal(viaStfu.collared, true);
  const viaMounted = applyDiscipline(applyDiscipline(collared, "doggy"), "facial");
  assert.equal(viaMounted.mounted, false);
  assert.equal(viaMounted.faceMarked, true);
  assert.equal(viaMounted.collared, true);
});
test("applyDiscipline: /release fully lifts suppression AND collar, from any sub-state, no reply", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const pushed = applyDiscipline(applyDiscipline(collared, "stfu"), "push");
  const released = applyDiscipline(pushed, "release");
  assert.equal(released.collared, false);
  assert.equal(released.suppressed, false);
  assert.equal(released.suppressDepth, 0);
  assert.equal(released.maxLines, undefined);
  assert.ok(!("reply" in released));
});
test("applyDiscipline: /doggy is independent of /stfu — valid any time collared", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const mounted = applyDiscipline(collared, "doggy");
  assert.equal(mounted.mounted, true);
  assert.equal(mounted.suppressed, false);
  // Also mountable while suppressed.
  const stfu = applyDiscipline(collared, "stfu");
  const mountedWhileGagged = applyDiscipline(stfu, "doggy");
  assert.equal(mountedWhileGagged.mounted, true);
  assert.equal(mountedWhileGagged.suppressed, true);
});
test("applyDiscipline: /creampie only valid while mounted; ends mounted, collar stays; no-op otherwise", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const tooEarly = applyDiscipline(collared, "creampie");
  assert.deepEqual(tooEarly, collared); // no-op: not mounted
  const mounted = applyDiscipline(collared, "doggy");
  const finished = applyDiscipline(mounted, "creampie");
  assert.equal(finished.mounted, false);
  assert.equal(finished.collared, true);
});
// --- render/post-layer enforcement (never prompt-only, never fabricated) ---
test("renderDogOutput: uncollared room passes the reply through untouched", () => {
  const state = initialDogModeState();
  assert.equal(renderDogOutput("line1\nline2\nline3", state, CFG), "line1\nline2\nline3");
});
test("renderDogOutput: collared room hard-caps to MaxLines lines with the register prefix", () => {
  const state = applyDogVerb(undefined, "on").state;
  const rendered = renderDogOutput("line1\nline2\nline3\nline4", state, CFG);
  const lines = rendered.split("\n");
  assert.equal(lines.length, 3); // prefix + 2 body lines (MaxLines=2)
  assert.equal(lines[1], "line1");
  assert.equal(lines[2], "line2");
});
test("renderDogOutput: /stfu-suppressed room caps the REAL reply to MaxLines 1 — never a fabricated string", () => {
  const stfu = applyDiscipline(applyDogVerb(undefined, "on").state, "stfu");
  const rendered = renderDogOutput("*whimpers pathetically*\nmore lines the agent said", stfu, CFG);
  assert.equal(rendered, `${"\uD83D\uDC3E *kneeling, collared*"}\n*whimpers pathetically*`);
});
test("renderDogOutput: /push-gagged room shows ONLY the prefix (MaxLines 0) — the agent's real words are trimmed away, nothing invented", () => {
  const pushed = applyDiscipline(applyDiscipline(applyDogVerb(undefined, "on").state, "stfu"), "push");
  const rendered = renderDogOutput("a whole essay the agent actually said", pushed, CFG);
  assert.equal(rendered, "\uD83D\uDC3E *kneeling, collared*");
});
test("renderDogOutput: MaxLines=0 (config or /push override) shows only the register prefix, no body", () => {
  const state = applyDogVerb(undefined, "on").state;
  assert.equal(renderDogOutput("a whole paragraph", state, { maxLines: 0 }), "\uD83D\uDC3E *kneeling, collared*");
});
test("renderDogStatus: reflects collar/suppressed/mounted/discipline/faceMarked", () => {
  const off = renderDogStatus(undefined, CFG);
  assert.match(off, /collar: off/);
  const collared = applyDogVerb(undefined, "on").state;
  const marked = applyDiscipline(applyDiscipline(collared, "doggy"), "facial");
  const status = renderDogStatus(marked, CFG);
  assert.match(status, /collar: on/);
  assert.match(status, /mounted: no/); // /facial ended the mount
  assert.match(status, /face: marked/);
});
// --- RoomState round-trip -----------------------------------------------------
test("normalizeRoomState: dogMode round-trips, and an all-default shape collapses to absent", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const pushed = applyDiscipline(applyDiscipline(collared, "stfu"), "push");
  const normalized = normalizeRoomState({ dogMode: pushed });
  // false/undefined optional fields (mounted, faceMarked) drop on the sparse
  // round-trip, same policy as every other optional RoomState field — the
  // MEANINGFUL fields (collared/suppressed/suppressDepth/maxLines/discipline) survive exactly.
  assert.deepEqual(normalized.dogMode, {
    collared: true,
    disciplineCount: 1,
    suppressed: true,
    suppressDepth: 1,
    maxLines: 0,
  });
  const empty = normalizeRoomState({ dogMode: { collared: false, disciplineCount: 0, suppressed: false, suppressDepth: 0 } });
  assert.equal(empty.dogMode, undefined);
  const garbage = normalizeRoomState({ dogMode: "not an object" });
  assert.equal(garbage.dogMode, undefined);
});
test("normalizeRoomState: disciplineCount alone (collared false) still round-trips — the tally survives /dog off", () => {
  const normalized = normalizeRoomState({ dogMode: { collared: false, disciplineCount: 3, suppressed: false, suppressDepth: 0 } });
  assert.deepEqual(normalized.dogMode, { collared: false, disciplineCount: 3, suppressed: false, suppressDepth: 0 });
});
