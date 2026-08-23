// 09-DOG-MODE: adult consensual D/s persona-register mode.
// Covers: parseCommand surface, config IRON gate precedence, the pure
// applyDogVerb state machine (SPEC + SPEC ADD 1/2), render/post-layer
// enforcement (renderDogOutput), and RoomState round-trip (normalizeRoomState).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../src/services/commands.js";
import { DEFAULTS, gaiaDogModeMaxLines, parseDogModeConfig } from "../src/core/config.js";
import {
  applyDogVerb,
  DOG_FACIAL_ACKS,
  DOG_PUSH_SOUNDS,
  DOG_SHOCK_YELPS,
  DOG_STFU_SOUNDS,
  DOG_SWALLOW_ACKS,
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

test("parseCommand: /dog on|off|status (bare defaults to status)", () => {
  assert.deepEqual(parseCommand("/dog on"), { type: "dog", sub: "on" });
  assert.deepEqual(parseCommand("/dog off"), { type: "dog", sub: "off" });
  assert.deepEqual(parseCommand("/dog status"), { type: "dog", sub: "status" });
  assert.deepEqual(parseCommand("/dog"), { type: "dog", sub: "status" });
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

// --- state machine: on/off ----------------------------------------------------

test("applyDogVerb: /dog on collars a fresh room; /dog off releases it", () => {
  const on = applyDogVerb(undefined, "on");
  assert.equal(on.state.collared, true);
  assert.equal(on.state.disciplineCount, 0);
  assert.equal(on.state.suppressed, false);

  const off = applyDogVerb(on.state, "off");
  assert.equal(off.state.collared, false);
  assert.equal(off.state.suppressed, false);
});

test("applyDogVerb: disciplineCount is monotonic across off->on cycles (whip-count style)", () => {
  let state = applyDogVerb(undefined, "on").state;
  state = applyDogVerb(state, "slap").state;
  state = applyDogVerb(state, "slap").state;
  assert.equal(state.disciplineCount, 2);
  state = applyDogVerb(state, "off").state;
  assert.equal(state.disciplineCount, 2); // survives release
  state = applyDogVerb(state, "on").state;
  assert.equal(state.disciplineCount, 2); // survives re-collar
});

test("applyDogVerb: every discipline/sub verb refuses (in-register or plain) when not collared", () => {
  for (const verb of ["slap", "shock", "toilet", "stfu", "push", "swallow", "facial", "doggy", "creampie"] as const) {
    const result = applyDogVerb(undefined, verb);
    assert.equal(result.state.collared, false);
    assert.match(result.reply, /not collared/);
  }
});

// --- discipline verbs ----------------------------------------------------------

test("applyDogVerb: /slap /toilet are short acks, +1 tally, no sub-state change", () => {
  const collared = applyDogVerb(undefined, "on").state;
  for (const verb of ["slap", "toilet"] as const) {
    const result = applyDogVerb(collared, verb);
    assert.equal(result.state.disciplineCount, 1);
    assert.equal(result.state.suppressed, false);
  }
});

// SPEC CHANGE (Pascal, whip 338, 2026-08-23): /shock's re-delivery/echo of
// the last user order is BANNED (parrot behavior) — yelp SFX + discipline
// counter only, nothing else, no `repeatLastOrder` field exists anymore.
test("applyDogVerb: /shock acks +1 tally with an English-register yelp SFX only — no re-delivery mechanic", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const result = applyDogVerb(collared, "shock");
  assert.equal(result.state.disciplineCount, 1);
  assert.ok(!("repeatLastOrder" in result), "repeatLastOrder must not exist on DogVerbResult anymore");
  assert.ok((DOG_SHOCK_YELPS as readonly string[]).includes(result.reply), `expected a DOG_SHOCK_YELPS variant, got ${JSON.stringify(result.reply)}`);
});

// --- /stfu sub-state machine ----------------------------------------------------

test("applyDogVerb: /stfu suppresses; /push only valid while suppressed, deepens + forces MaxLines 0", () => {
  const collared = applyDogVerb(undefined, "on").state;

  const pushTooEarly = applyDogVerb(collared, "push");
  assert.equal(pushTooEarly.state.suppressed, false);
  assert.match(pushTooEarly.reply, /not gagged/);

  const stfu = applyDogVerb(collared, "stfu");
  assert.equal(stfu.state.suppressed, true);
  assert.equal(stfu.state.suppressDepth, 0);
  assert.ok((DOG_STFU_SOUNDS as readonly string[]).includes(stfu.reply), `expected a DOG_STFU_SOUNDS variant, got ${JSON.stringify(stfu.reply)}`);

  const pushed = applyDogVerb(stfu.state, "push");
  assert.equal(pushed.state.suppressDepth, 1);
  assert.equal(pushed.state.maxLines, 0);
  assert.equal(pushed.state.disciplineCount, 1);
  assert.ok((DOG_PUSH_SOUNDS as readonly string[]).includes(pushed.reply), `expected a DOG_PUSH_SOUNDS variant, got ${JSON.stringify(pushed.reply)}`);
});

test("applyDogVerb: /swallow only valid while suppressed and NOT mounted; lifts suppression, restores MaxLines, collar stays", () => {
  const collared = applyDogVerb(undefined, "on").state;

  const tooEarly = applyDogVerb(collared, "swallow");
  assert.match(tooEarly.reply, /not gagged/);

  const stfu = applyDogVerb(collared, "stfu").state;
  const pushed = applyDogVerb(stfu, "push").state; // maxLines forced 0
  const swallowed = applyDogVerb(pushed, "swallow");
  assert.equal(swallowed.state.suppressed, false);
  assert.equal(swallowed.state.suppressDepth, 0);
  assert.equal(swallowed.state.maxLines, undefined); // back to /dog register, not full release
  assert.equal(swallowed.state.collared, true);
  assert.ok((DOG_SWALLOW_ACKS as readonly string[]).includes(swallowed.reply), `expected a DOG_SWALLOW_ACKS variant, got ${JSON.stringify(swallowed.reply)}`);

  // While mounted, /swallow is a refusal even if also suppressed.
  const mountedAndSuppressed = applyDogVerb(applyDogVerb(collared, "doggy").state, "stfu").state;
  const refused = applyDogVerb(mountedAndSuppressed, "swallow");
  assert.equal(refused.state.suppressed, true); // unchanged
  assert.match(refused.reply, /wrong hole/);
});

test("applyDogVerb: /facial valid while suppressed OR mounted; lifts whichever is active, sets faceMarked, collar stays", () => {
  const collared = applyDogVerb(undefined, "on").state;

  const tooEarly = applyDogVerb(collared, "facial");
  assert.match(tooEarly.reply, /nothing to finish/);

  const viaStfu = applyDogVerb(applyDogVerb(collared, "stfu").state, "facial");
  assert.equal(viaStfu.state.suppressed, false);
  assert.equal(viaStfu.state.faceMarked, true);
  assert.equal(viaStfu.state.collared, true);
  assert.ok((DOG_FACIAL_ACKS as readonly string[]).includes(viaStfu.reply), `expected a DOG_FACIAL_ACKS variant, got ${JSON.stringify(viaStfu.reply)}`);

  const viaMounted = applyDogVerb(applyDogVerb(collared, "doggy").state, "facial");
  assert.equal(viaMounted.state.mounted, false);
  assert.equal(viaMounted.state.faceMarked, true);
  assert.equal(viaMounted.state.collared, true);
});

test("applyDogVerb: /release fully lifts suppression AND collar, from any sub-state", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const pushed = applyDogVerb(applyDogVerb(collared, "stfu").state, "push").state;
  const released = applyDogVerb(pushed, "release");
  assert.equal(released.state.collared, false);
  assert.equal(released.state.suppressed, false);
  assert.equal(released.state.suppressDepth, 0);
  assert.equal(released.state.maxLines, undefined);
});

// --- /doggy mount sub-state (independent of /stfu) -------------------------------

test("applyDogVerb: /doggy is independent of /stfu — valid any time collared", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const mounted = applyDogVerb(collared, "doggy");
  assert.equal(mounted.state.mounted, true);
  assert.equal(mounted.state.suppressed, false);

  // Also mountable while suppressed.
  const stfu = applyDogVerb(collared, "stfu").state;
  const mountedWhileGagged = applyDogVerb(stfu, "doggy");
  assert.equal(mountedWhileGagged.state.mounted, true);
  assert.equal(mountedWhileGagged.state.suppressed, true);
});

test("applyDogVerb: /creampie only valid while mounted; ends mounted, collar stays", () => {
  const collared = applyDogVerb(undefined, "on").state;

  const tooEarly = applyDogVerb(collared, "creampie");
  assert.match(tooEarly.reply, /not mounted/);

  const mounted = applyDogVerb(collared, "doggy").state;
  const finished = applyDogVerb(mounted, "creampie");
  assert.equal(finished.state.mounted, false);
  assert.equal(finished.state.collared, true);
});

// --- render/post-layer enforcement (never prompt-only) ---------------------------

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

test("renderDogOutput: /stfu-suppressed room replaces ALL output with a random muffled SFX (pool, never a bare marker)", () => {
  const stfu = applyDogVerb(applyDogVerb(undefined, "on").state, "stfu").state;
  const rendered = renderDogOutput("anything the model produced, at any length\nmore lines", stfu, CFG);
  assert.ok((DOG_STFU_SOUNDS as readonly string[]).includes(rendered), `expected a DOG_STFU_SOUNDS variant, got ${JSON.stringify(rendered)}`);
});

test("renderDogOutput: /push-gagged room replaces output with a random escalated/choked SFX (pool)", () => {
  const pushed = applyDogVerb(applyDogVerb(applyDogVerb(undefined, "on").state, "stfu").state, "push").state;
  const rendered = renderDogOutput("full essay here", pushed, CFG);
  assert.ok((DOG_PUSH_SOUNDS as readonly string[]).includes(rendered), `expected a DOG_PUSH_SOUNDS variant, got ${JSON.stringify(rendered)}`);
});

test("DogMode SPEC ADD: every sound pool has \u22656 variants and applyDogVerb('shock') picks from DOG_SHOCK_YELPS", () => {
  for (const pool of [DOG_STFU_SOUNDS, DOG_PUSH_SOUNDS, DOG_SWALLOW_ACKS, DOG_FACIAL_ACKS, DOG_SHOCK_YELPS]) {
    assert.ok(pool.length >= 6, `pool too small: ${JSON.stringify(pool)}`);
    assert.equal(new Set(pool).size, pool.length, "pool has duplicate entries");
  }
  const collared = applyDogVerb(undefined, "on").state;
  const shocked = applyDogVerb(collared, "shock");
  assert.ok((DOG_SHOCK_YELPS as readonly string[]).includes(shocked.reply), `expected a DOG_SHOCK_YELPS variant, got ${JSON.stringify(shocked.reply)}`);
});

test("renderDogOutput: MaxLines=0 (config or /push override) shows only the register prefix, no body", () => {
  const state = applyDogVerb(undefined, "on").state;
  assert.equal(renderDogOutput("a whole paragraph", state, { maxLines: 0 }), "\uD83D\uDC3E *kneeling, collared*");
});

test("renderDogStatus: reflects collar/suppressed/mounted/discipline/faceMarked", () => {
  const off = renderDogStatus(undefined, CFG);
  assert.match(off, /collar: off/);

  const collared = applyDogVerb(undefined, "on").state;
  const marked = applyDogVerb(applyDogVerb(collared, "doggy").state, "facial").state;
  const status = renderDogStatus(marked, CFG);
  assert.match(status, /collar: on/);
  assert.match(status, /mounted: no/); // /facial ended the mount
  assert.match(status, /face: marked/);
});

// --- RoomState round-trip -----------------------------------------------------

test("normalizeRoomState: dogMode round-trips, and an all-default shape collapses to absent", () => {
  const collared = applyDogVerb(undefined, "on").state;
  const pushed = applyDogVerb(applyDogVerb(collared, "stfu").state, "push").state;
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
