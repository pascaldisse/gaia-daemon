// summons-state — child-room seeding goes through RoomHandle (delta), not a
// whole-document overwrite: unknown/future fields on the child's state.json
// survive, and a no-op seed leaves the file byte-identical.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomHandle } from "../src/domain/rooms.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { workspacePaths } from "../src/core/paths.js";

async function fixture(prefix: string): Promise<{ proj: string; cleanup(): Promise<void> }> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  await mkdir(proj, { recursive: true });
  await initWorkspace(proj);
  return {
    proj,
    cleanup: async () => {
      if (prevHome === undefined) delete process.env.GAIA_HOME;
      else process.env.GAIA_HOME = prevHome;
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** The exact delta summons.ts applies when seeding a child room. */
async function seedChild(proj: string, childRoomId: string): Promise<void> {
  const handle = await RoomHandle.open(proj, childRoomId);
  await handle.updateState((state) => {
    state.parentRoomId = "parent";
    state.summonUntrusted = true;
    state.summon = {
      agentId: "luna",
      deliver: { kind: "room", roomId: "parent" },
      status: "running",
      launchedAt: "2026-01-01T00:00:00.000Z",
    } as never;
  });
}

test("summon child seeding preserves unknown/future fields on the child state", async () => {
  const fx = await fixture("gaia-summon-state-a-");
  try {
    const childRoomId = "luna-child";
    const statePath = workspacePaths.roomState(fx.proj, childRoomId);
    await mkdir(join(statePath, ".."), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({ activeRoles: {}, futureScalar: "keep-me", futureBlock: { nested: [1, 2, 3] } }, null, 2)}\n`,
    );

    await seedChild(fx.proj, childRoomId);

    const after = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    assert.equal(after.parentRoomId, "parent");
    assert.equal(after.summonUntrusted, true);
    assert.equal(after.futureScalar, "keep-me", "unknown scalar dropped by child seeding");
    assert.deepEqual(after.futureBlock, { nested: [1, 2, 3] }, "unknown nested field dropped by child seeding");
  } finally {
    await fx.cleanup();
  }
});

test("re-seeding the same child is a byte-stable no-op", async () => {
  const fx = await fixture("gaia-summon-state-b-");
  try {
    const childRoomId = "luna-child";
    await seedChild(fx.proj, childRoomId);
    const statePath = workspacePaths.roomState(fx.proj, childRoomId);
    const original = await readFile(statePath, "utf8");
    await seedChild(fx.proj, childRoomId);
    assert.equal(await readFile(statePath, "utf8"), original, "identical seed rewrote state.json");
  } finally {
    await fx.cleanup();
  }
});
