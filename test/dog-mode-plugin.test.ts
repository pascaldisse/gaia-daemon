// 09-DOG-MODE, extracted to a bundled command-plugin (whip 348): adult
// consensual D/s persona-register mode, same plugin API/shape as
// ~/.gaia/plugins/whip.mjs (services/plugins.ts CommandPlugin) — tested the
// same way test/rpg-plugin.test.ts tests plugins/rpg.mjs: import the default
// export directly and drive its run()/renderCap()/turnStart() hooks, no
// daemon/RoomService involved (see test/dog-mode-integration.test.ts for the
// full RoomService pipeline proof).
//
// Covers: the pure on/off/toggle/status collar switch, the pure discipline/
// state-verb transform (SPEC REWRITE, Pascal whips 344-346: NO reply text of
// any kind for any verb but on/off/status — every discipline verb comes back
// as `rewriteAsMessage` so the room's agent generates the actual reply),
// renderCap (whip 349: `{maxLines}` ONLY, never a prefix baked into the
// agent's text — the collar reminder is a separate SYSTEM `note`), and
// turnStart (the transient /facial marker expiring at the next turn).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import plugin from "../plugins/defaults/dog-mode.mjs";
import { createTempDir } from "./helpers/temp.js";

const MARK = "\uD83D\uDC3E";

function ctx(overrides = {}) {
  return {
    homedir: "/tmp/gaia",
    roomId: "room1",
    workspaceRoot: "/tmp/gaia-workspace-missing",
    agents: [{ id: "gaia", displayName: "Gaia", icon: "\uD83E\uDD16" }],
    ...overrides,
  };
}

async function withEnv(vars, fn) {
  const previous = {};
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

// --- plugin shape -------------------------------------------------------------

test("plugin owns every DogMode command name under one shared id", () => {
  assert.deepEqual(
    [...plugin.command],
    ["dog", "slap", "shock", "toilet", "stfu", "push", "swallow", "facial", "release", "doggy", "creampie"],
  );
  assert.equal(plugin.id, "dog");
  assert.equal(typeof plugin.run, "function");
  assert.equal(typeof plugin.renderCap, "function");
  assert.equal(typeof plugin.turnStart, "function");
  assert.equal(typeof plugin.prompt, "function");
});

// --- /dog on|off|status|toggle -------------------------------------------------

test("/dog: fresh room toggles on (bare /dog), reports plain system text", async () => {
  const on = await plugin.run([], ctx({ command: "dog" }));
  assert.equal(on.state.collared, true);
  assert.equal(on.state.disciplineCount, 0);
  assert.equal(on.state.suppressed, false);
  assert.match(on.reply, /collar clicks shut/i);
  assert.equal(on.rewriteAsMessage, undefined);
});

test("/dog on twice, /dog off twice \u2014 plain redundant-call replies, no crash", async () => {
  const on = await plugin.run(["on"], ctx({ command: "dog" }));
  const onAgain = await plugin.run(["on"], ctx({ command: "dog", state: on.state }));
  assert.equal(onAgain.state.collared, true);
  assert.match(onAgain.reply, /already collared/);
  const off = await plugin.run(["off"], ctx({ command: "dog", state: onAgain.state }));
  const offAgain = await plugin.run(["off"], ctx({ command: "dog", state: off.state }));
  assert.equal(offAgain.state.collared, false);
  assert.match(offAgain.reply, /not collared/);
});

test("/dog: bare toggle flips whichever way collar currently is NOT", async () => {
  const on = await plugin.run([], ctx({ command: "dog" }));
  assert.equal(on.state.collared, true);
  const off = await plugin.run([], ctx({ command: "dog", state: on.state }));
  assert.equal(off.state.collared, false);
});

test("/dog status never mutates \u2014 absent for a fresh room, and garbage sub-args report status too", async () => {
  const status = await plugin.run(["status"], ctx({ command: "dog" }));
  assert.equal(status.state, undefined);
  assert.match(status.reply, /collar: off/i);
  const garbage = await plugin.run(["garbage"], ctx({ command: "dog" }));
  assert.equal(garbage.state, undefined);
  assert.match(garbage.reply, /collar: off/i);
});

test("/dog status while collared reports maxLines/suppressed/mounted/discipline/faceMarked", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const mounted = (await plugin.run([], ctx({ command: "doggy", state: collared }))).state;
  const marked = (await plugin.run([], ctx({ command: "facial", state: mounted }))).state;
  const status = await plugin.run(["status"], ctx({ command: "dog", state: marked }));
  assert.match(status.reply, /collar: on/);
  assert.match(status.reply, /mounted: no/); // /facial ended the mount
  assert.match(status.reply, /face: marked/);
  assert.ok(status.reply.startsWith(MARK));
});

// --- discipline verbs: pure state transition + always a real turn -------------

test("discipline verb before /dog on is STILL rewritten to a real turn \u2014 uncollared means no state change", async () => {
  const result = await plugin.run([], ctx({ command: "slap" }));
  assert.equal(result.rewriteAsMessage, true);
  assert.equal(result.state.collared, false);
  assert.equal(result.state.disciplineCount, 0);
  // `targets` is deliberately absent \u2014 RoomService's own #roomDefaultTarget
  // fills it in (see services/plugins.ts PluginResult.targets doc); the
  // plugin has no accurate way to re-derive that from raw workspaceRoot
  // reads (see the deleted target-resolution test this replaced, whip 348 fix).
  assert.equal(result.targets, undefined);
  assert.equal(result.reply, undefined);
  assert.equal(result.steer, undefined);
});

test("/slap /toilet /shock: +1 tally each, no sub-state change, always rewriteAsMessage", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  for (const verb of ["slap", "toilet", "shock"]) {
    const result = await plugin.run([], ctx({ command: verb, state: collared }));
    assert.equal(result.state.disciplineCount, 1);
    assert.equal(result.state.suppressed, false);
    assert.equal(result.rewriteAsMessage, true);
  }
});

test("disciplineCount is monotonic across /dog off\u2192on cycles (whip-count style)", async () => {
  let state = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  state = (await plugin.run([], ctx({ command: "slap", state }))).state;
  state = (await plugin.run([], ctx({ command: "slap", state }))).state;
  assert.equal(state.disciplineCount, 2);
  state = (await plugin.run(["off"], ctx({ command: "dog", state }))).state;
  assert.equal(state.disciplineCount, 2);
  state = (await plugin.run(["on"], ctx({ command: "dog", state }))).state;
  assert.equal(state.disciplineCount, 2);
});

test("/stfu suppresses with maxLines 1; /push only deepens while suppressed, forces maxLines 0", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const pushTooEarly = (await plugin.run([], ctx({ command: "push", state: collared }))).state;
  assert.equal(pushTooEarly.suppressed, false);
  assert.equal(pushTooEarly.maxLines, undefined);
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  assert.equal(stfu.suppressed, true);
  assert.equal(stfu.suppressDepth, 0);
  assert.equal(stfu.maxLines, 1);
  const stfuAgain = (await plugin.run([], ctx({ command: "stfu", state: stfu }))).state;
  assert.deepEqual(stfuAgain, stfu);
  const pushed = (await plugin.run([], ctx({ command: "push", state: stfu }))).state;
  assert.equal(pushed.suppressDepth, 1);
  assert.equal(pushed.maxLines, 0);
  assert.equal(pushed.disciplineCount, 1);
});

test("/swallow only valid while suppressed and NOT mounted; lifts suppression, restores maxLines, collar stays", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const tooEarly = (await plugin.run([], ctx({ command: "swallow", state: collared }))).state;
  assert.equal(tooEarly.suppressed, false);
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const pushed = (await plugin.run([], ctx({ command: "push", state: stfu }))).state;
  const swallowed = (await plugin.run([], ctx({ command: "swallow", state: pushed }))).state;
  assert.equal(swallowed.suppressed, false);
  assert.equal(swallowed.suppressDepth, 0);
  assert.equal(swallowed.maxLines, undefined);
  assert.equal(swallowed.collared, true);
  const mountedAndSuppressed = (await plugin.run([], ctx({ command: "stfu", state: (await plugin.run([], ctx({ command: "doggy", state: collared }))).state }))).state;
  const refused = (await plugin.run([], ctx({ command: "swallow", state: mountedAndSuppressed }))).state;
  assert.deepEqual(refused, mountedAndSuppressed);
});

test("/facial valid while suppressed OR mounted; lifts whichever is active, sets faceMarked, collar stays", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const tooEarly = (await plugin.run([], ctx({ command: "facial", state: collared }))).state;
  assert.deepEqual(tooEarly, collared);
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const viaStfu = (await plugin.run([], ctx({ command: "facial", state: stfu }))).state;
  assert.equal(viaStfu.suppressed, false);
  assert.equal(viaStfu.faceMarked, true);
  assert.equal(viaStfu.collared, true);
  const mounted = (await plugin.run([], ctx({ command: "doggy", state: collared }))).state;
  const viaMounted = (await plugin.run([], ctx({ command: "facial", state: mounted }))).state;
  assert.equal(viaMounted.mounted, false);
  assert.equal(viaMounted.faceMarked, true);
  assert.equal(viaMounted.collared, true);
});

test("/release fully lifts suppression AND collar, from any sub-state", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const pushed = (await plugin.run([], ctx({ command: "push", state: stfu }))).state;
  const released = (await plugin.run([], ctx({ command: "release", state: pushed }))).state;
  assert.equal(released.collared, false);
  assert.equal(released.suppressed, false);
  assert.equal(released.suppressDepth, 0);
  assert.equal(released.maxLines, undefined);
});

test("/doggy is independent of /stfu \u2014 valid any time collared", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const mounted = (await plugin.run([], ctx({ command: "doggy", state: collared }))).state;
  assert.equal(mounted.mounted, true);
  assert.equal(mounted.suppressed, false);
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const mountedWhileGagged = (await plugin.run([], ctx({ command: "doggy", state: stfu }))).state;
  assert.equal(mountedWhileGagged.mounted, true);
  assert.equal(mountedWhileGagged.suppressed, true);
});

test("/creampie only valid while mounted; ends mounted, collar stays; no-op otherwise", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const tooEarly = (await plugin.run([], ctx({ command: "creampie", state: collared }))).state;
  assert.deepEqual(tooEarly, collared);
  const mounted = (await plugin.run([], ctx({ command: "doggy", state: collared }))).state;
  const finished = (await plugin.run([], ctx({ command: "creampie", state: mounted }))).state;
  assert.equal(finished.mounted, false);
  assert.equal(finished.collared, true);
});

// --- target resolution for rewriteAsMessage ------------------------------------
//
// A prior revision of this plugin re-derived the target agent itself, via raw
// reads of workspaceRoot/.gaia/{config,rooms/<id>/state}.json \u2014 falling back
// to a literal "unknown" agent id whenever neither file had what it wanted. That
// was a real bug, not just a test-fixture quirk: a workspace's resolved
// `config.defaultAgent` (core/config.ts DEFAULTS, always "gaia" unless overridden)
// is an in-memory merge the daemon computes \u2014 config.json on disk is never
// REQUIRED to literally contain that key, so this file-read fallback could (and,
// live, did) misroute a discipline verb to "@unknown" the moment a room's very
// first turn was a discipline verb. Fixed by deleting the re-derivation entirely:
// `targets` is left unset (see the test above) and RoomService's own accurate
// #roomDefaultTarget resolves it, exactly per the documented default in
// services/plugins.ts PluginResult.targets.

// --- renderCap: {maxLines} ONLY, never a prefix (whip 349) ---------------------

test("renderCap: uncollared room \u2014 no cap at all", async () => {
  assert.equal(await plugin.renderCap(ctx({ state: undefined })), undefined);
});

test("renderCap: collared room caps to the default 2 lines, no prefix field anywhere, note is separate system chrome", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const cap = await plugin.renderCap(ctx({ state: collared, workspaceRoot: "/tmp/gaia-does-not-exist-at-all" }));
  assert.deepEqual(Object.keys(cap).sort(), ["maxLines", "note"]);
  assert.equal(cap.maxLines, 2);
  assert.equal(cap.prefix, undefined);
  assert.match(cap.note, /^\uD83D\uDC3E collared \u2014 display capped to 2 lines\.$/);
});

test("renderCap: /stfu-suppressed \u2014 maxLines 1, note mentions suppressed", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const cap = await plugin.renderCap(ctx({ state: stfu, workspaceRoot: "/tmp/gaia-does-not-exist-at-all" }));
  assert.equal(cap.maxLines, 1);
  assert.match(cap.note, /\(suppressed\)/);
});

test("renderCap: /push-gagged \u2014 maxLines 0, note says silenced + gagged", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const pushed = (await plugin.run([], ctx({ command: "push", state: stfu }))).state;
  const cap = await plugin.renderCap(ctx({ state: pushed, workspaceRoot: "/tmp/gaia-does-not-exist-at-all" }));
  assert.equal(cap.maxLines, 0);
  assert.match(cap.note, /silenced/);
  assert.match(cap.note, /\(gagged\)/);
});

test("renderCap maxLines: config.json dogMode.maxLines is the fallback; GAIA_DOGMODE_MAXLINES env wins", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const temp = await createTempDir("gaia-dogmode-cfg-");
  try {
    await mkdir(join(temp.path, ".gaia"), { recursive: true });
    await writeFile(join(temp.path, ".gaia", "config.json"), JSON.stringify({ dogMode: { maxLines: 4 } }), "utf8");
    await withEnv({ GAIA_DOGMODE_MAXLINES: undefined }, async () => {
      const cap = await plugin.renderCap(ctx({ state: collared, workspaceRoot: temp.path }));
      assert.equal(cap.maxLines, 4);
    });
    await withEnv({ GAIA_DOGMODE_MAXLINES: "0" }, async () => {
      const cap = await plugin.renderCap(ctx({ state: collared, workspaceRoot: temp.path }));
      assert.equal(cap.maxLines, 0);
    });
  } finally {
    await temp.cleanup();
  }
});

// --- turnStart: expires the transient /facial marker ---------------------------

test("turnStart: clears faceMarked, leaves everything else untouched; no-op when absent", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  const marked = (await plugin.run([], ctx({ command: "facial", state: (await plugin.run([], ctx({ command: "doggy", state: collared }))).state }))).state;
  assert.equal(marked.faceMarked, true);
  const cleared = await plugin.turnStart(ctx({ state: marked }));
  assert.equal(cleared.faceMarked, undefined);
  assert.equal(cleared.collared, true);
  assert.equal(await plugin.turnStart(ctx({ state: collared })), undefined);
});

// --- prompt: the suppressed-register hint, never fabricated reply text ---------

test("prompt: only nudges while collared AND suppressed \u2014 absent otherwise", async () => {
  const collared = (await plugin.run(["on"], ctx({ command: "dog" }))).state;
  assert.equal(await plugin.prompt({ ...ctx({ state: collared }), agentId: "gaia" }), undefined);
  const stfu = (await plugin.run([], ctx({ command: "stfu", state: collared }))).state;
  const hint = await plugin.prompt({ ...ctx({ state: stfu }), agentId: "gaia" });
  assert.match(hint, /suppressed\/gagged/);
  assert.equal(await plugin.prompt({ ...ctx({ state: undefined }), agentId: "gaia" }), undefined);
});

// --- defensive normalization: garbage state never crashes ----------------------

test("garbage/partial state never crashes run/renderCap/turnStart \u2014 always resolves to sane defaults", async () => {
  const fromGarbage = await plugin.run(["status"], ctx({ command: "dog", state: "not an object" }));
  assert.match(fromGarbage.reply, /collar: off/i);
  assert.equal(await plugin.renderCap(ctx({ state: "not an object" })), undefined);
  assert.equal(await plugin.turnStart(ctx({ state: "not an object" })), undefined);
  const partial = await plugin.run([], ctx({ command: "slap", state: { collared: true, disciplineCount: "nope", maxLines: -5 } }));
  assert.equal(partial.state.disciplineCount, 1); // garbage 0 + 1
  assert.equal(partial.state.maxLines, undefined); // -5 is not a valid maxLines
});
