// Sidebar drag-drop reorder of a workspace's top-level rooms (daemon.ts
// Daemon.reorderRooms + services/room/snapshot.ts scanRoomActivity) — the
// server half of "reorder rooms by drag/drop", room-scoped counterpart of
// test/workspace-registry-order.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/harness/index.js";
import { Daemon } from "../src/daemon.js";
import { ensureWorkspaceRoom, initWorkspace } from "../src/domain/workspace.js";

test("room drag-drop reorder persists top-level order across a fresh scan; favorite status is untouched", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project); // config.room = "default"
    await ensureWorkspaceRoom(project, "room-b");
    await ensureWorkspaceRoom(project, "room-c");

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);

    // Baseline: newest-created-first (scanRoomActivity's activity-mtime sort,
    // no manual order yet).
    const baseline = await daemon.serviceFor(record.id).then((service) => service.listRooms());
    assert.deepEqual(
      baseline.map((room) => room.id).sort(),
      ["default", "room-b", "room-c"].sort(),
      "baseline has all three rooms",
    );

    // Drag room-c to the front, default last.
    const reordered = await daemon.reorderRooms(record.id, ["room-c", "room-b", "default"]);
    assert.deepEqual(reordered.rooms.map((room) => room.id), ["room-c", "room-b", "default"]);

    // Favoriting a room afterwards must not disturb the drag order (rooms are
    // favorite-FILTERED via the sidebar toggle, not favorite-sorted — unlike
    // workspaces, see scanRoomActivity's comment).
    await daemon.setRoomFavorite(record.id, "default", true);
    const afterFavorite = await daemon.serviceFor(record.id).then((service) => service.listRooms());
    assert.deepEqual(afterFavorite.map((room) => room.id), ["room-c", "room-b", "default"]);
    assert.equal(afterFavorite.find((room) => room.id === "default")?.favorite, true);

    // Persistence: a brand-new Daemon instance reading the same workspace root
    // sees the identical order (real disk round-trip through
    // .gaia/room-order.json, not just in-memory).
    const daemon2 = new Daemon({ cwd: project, log: () => {} });
    const record2 = await daemon2.registry.add(project);
    const reread = await daemon2.serviceFor(record2.id).then((service) => service.listRooms());
    assert.deepEqual(reread.map((room) => room.id), ["room-c", "room-b", "default"]);

    // A room dropped from the dragged set (e.g. never re-sent by a partial
    // drag) simply falls back to activity order among the untouched rest —
    // reorder with only two of the three ids leaves the third (still on disk)
    // ordered by its own activity, not silently dropped from the list.
    const partial = await daemon.reorderRooms(record.id, ["room-b", "room-c"]);
    assert.equal(partial.rooms.length, 3, "a room left out of the reorder ids stays in the list");
    assert.deepEqual(partial.rooms.slice(0, 2).map((room) => room.id), ["room-b", "room-c"], "the two re-dragged rooms keep their new relative order");

    // Unknown workspace: a clean error, not a silent no-op.
    await assert.rejects(() => daemon.reorderRooms("does-not-exist", ["a"]), /Unknown workspace/);
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});
