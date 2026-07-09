import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/harness/index.js";
import { Daemon } from "../src/daemon.js";
import { readJson } from "../src/core/store.js";
import { workspacePaths } from "../src/core/paths.js";
import { ensureWorkspaceRoom, initWorkspace } from "../src/domain/workspace.js";

test("deleteRoom does not resurrect the deleted current room as an empty directory", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project); // config.room = default
    await ensureWorkspaceRoom(project, "next-room");

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);

    const result = await daemon.deleteRoom(record.id, "default");

    assert.equal(result.snapshot.room.id, "next-room");
    assert.equal(existsSync(workspacePaths.roomDir(project, "default")), false, "deleted room must stay gone, not be recreated by loadWorkspace");
    assert.equal(existsSync(workspacePaths.roomDir(project, "next-room")), true);
    assert.equal((await readJson(workspacePaths.config(project)) as { room?: string }).room, "next-room");
    assert.ok(!result.snapshot.rooms.some((room) => room.id === "default"), "sidebar room list must not include the deleted room");

    const trashed = await readdir(workspacePaths.roomTrashDir(project));
    assert.ok(trashed.some((name) => name.startsWith("default__")), "deleted room is still recoverable from trash");
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});
