// room-writers — falsification tests for state.json writers that BYPASS
// RoomHandle. RoomHandle.update writes via patchNormalizedState(raw, before,
// after), which preserves unknown / future fields on disk. The bypass writers
// (setups.ts:271 activateSetup, setups.ts:290 deactivateMonad,
// summons.ts:449 child seeding, room-service.ts:3374 fork) do
// readJson -> normalizeRoomState -> writeJsonAtomic, and normalizeRoomState
// is a whitelist: every key it does not know is DROPPED. Any field written by
// a newer daemon / a plugin / a future schema is destroyed by these writers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomHandle, normalizeRoomState } from "../src/domain/rooms.js";
import { activateSetup, deactivateMonad } from "../src/services/setups.js";
import { initWorkspace, loadWorkspace } from "../src/domain/workspace.js";
import { workspacePaths } from "../src/core/paths.js";

interface Fixture {
  proj: string;
  statePath: string;
  cleanup(): Promise<void>;
}

async function fixture(prefix: string, roomId = "default"): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  await mkdir(proj, { recursive: true });
  await initWorkspace(proj);
  return {
    proj,
    statePath: workspacePaths.roomState(proj, roomId),
    cleanup: async () => {
      if (prevHome === undefined) delete process.env.GAIA_HOME;
      else process.env.GAIA_HOME = prevHome;
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Stamp a state file that carries both a known field and two unknown/future
 * fields (a scalar and a nested object), as a newer daemon would write. */
async function seedState(statePath: string): Promise<void> {
  await mkdir(join(statePath, ".."), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        activeRoles: {},
        agentCursors: {},
        thinkingOverrides: {},
        futureScalar: "keep-me",
        futureBlock: { nested: [1, 2, 3] },
      },
      null,
      2,
    )}\n`,
  );
}

async function readState(statePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
}

// (a) activateSetup — a bypass writer — must not eat unknown/future fields.
test("(a) activateSetup preserves unknown/future state fields", async () => {
  const fx = await fixture("gaia-writers-a-");
  try {
    await seedState(fx.statePath);
    const workspace = await loadWorkspace(fx.proj);
    await activateSetup(workspace, "monad", "default");

    const after = await readState(fx.statePath);
    assert.ok(after.monad, "monad block should have been written");
    assert.equal(after.futureScalar, "keep-me", "unknown scalar field was dropped by activateSetup");
    assert.deepEqual(after.futureBlock, { nested: [1, 2, 3] }, "unknown nested field was dropped by activateSetup");
  } finally {
    await fx.cleanup();
  }
});

// (b) A second bypass writer with the identical read->normalize->write shape
// (setups.ts:290 deactivateMonad; summons.ts:449 child seeding is the same
// three lines against a child room) must not overwrite existing state it does
// not own. UNVERIFIED for summons.ts:449 itself — that path needs a live
// SummonService; this covers the shared shape.
test("(b) deactivateMonad (same read->normalize->write shape as summon seeding) does not clobber existing state", async () => {
  const fx = await fixture("gaia-writers-b-");
  try {
    const workspace = await loadWorkspace(fx.proj);
    await activateSetup(workspace, "monad", "default");

    // A newer daemon / plugin adds fields the current schema does not know.
    const before = await readState(fx.statePath);
    before.futureScalar = "keep-me";
    before.futureBlock = { nested: [1, 2, 3] };
    await writeFile(fx.statePath, `${JSON.stringify(before, null, 2)}\n`);

    assert.equal(await deactivateMonad(workspace, "default"), true);

    const after = await readState(fx.statePath);
    assert.equal(after.monad, undefined, "monad block should be gone");
    assert.equal(after.futureScalar, "keep-me", "unknown scalar field was clobbered");
    assert.deepEqual(after.futureBlock, { nested: [1, 2, 3] }, "unknown nested field was clobbered");
  } finally {
    await fx.cleanup();
  }
});

// (b2) Source guard, independent path: NO module outside domain/rooms.ts may
// write a room's state.json directly — RoomHandle is the sole serialized
// writer (core/types.ts:283). A direct writeJsonAtomic(roomState(...)) both
// races the handle's chain and drops unknown fields.
test("(b2) no module outside domain/rooms.ts writes roomState directly", async () => {
  const src = join(import.meta.dirname, "..", "src");
  const proc = Bun.spawnSync(["grep", "-rn", "writeJsonAtomic(", src]);
  const candidates = new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter((line) => line.trim() && !line.includes("/domain/rooms.ts:"));
  const hits: string[] = [];
  for (const line of candidates) {
    const file = line.slice(0, line.indexOf(":"));
    const arg = line.slice(line.indexOf("writeJsonAtomic(") + "writeJsonAtomic(".length).split(/[,)]/)[0]?.trim() ?? "";
    if (!arg) continue;
    const body = await readFile(file, "utf8");
    // Direct target, or a local bound to workspacePaths.roomState(...).
    const direct = arg.includes("roomState(");
    const bound = new RegExp(`(const|let)\\s+${arg.replace(/[^\w]/g, "")}\\s*=\\s*workspacePaths\\.roomState\\(`).test(body);
    if (direct || (arg.match(/^\w+$/) && bound)) hits.push(line);
  }
  assert.deepEqual(hits, [], `roomState writers bypassing RoomHandle:\n${hits.join("\n")}`);
});

// (c) Control + invariant: a no-op update must leave the file byte-identical.
// RoomHandle (the sanctioned writer) is expected to hold this; the bypass
// writers rewrite the file even when nothing changed, and lose bytes doing it.
test("(c) no-op writes leave state.json byte-identical", async () => {
  const fx = await fixture("gaia-writers-c-");
  try {
    await seedState(fx.statePath);
    const original = await readFile(fx.statePath, "utf8");

    const handle = await RoomHandle.open(fx.proj, "default");
    await handle.updateState(() => {});
    assert.equal(await readFile(fx.statePath, "utf8"), original, "RoomHandle no-op rewrote state.json");

    // Bypass writer, no-op case: deactivateMonad on a non-monad room returns
    // false and must not touch the file.
    const workspace = await loadWorkspace(fx.proj);
    assert.equal(await deactivateMonad(workspace, "default"), false);
    assert.equal(await readFile(fx.statePath, "utf8"), original, "no-op deactivateMonad rewrote state.json");

    // Sanity: normalizeRoomState alone is the lossy step.
    const normalized = normalizeRoomState(JSON.parse(original)) as Record<string, unknown>;
    assert.equal(normalized.futureScalar, undefined, "normalizeRoomState is expected to be a whitelist");
  } finally {
    await fx.cleanup();
  }
});
