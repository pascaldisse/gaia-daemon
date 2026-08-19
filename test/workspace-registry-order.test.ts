// Workspace sidebar favorites + drag-drop reorder (daemon.ts WorkspaceRegistry
// + Daemon.setWorkspaceFavorite/reorderWorkspaces) — the server half of the
// "reorder workspaces by drag/drop, favorites always on top" feature.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/harness/index.js";
import { Daemon } from "../src/daemon.js";
import { initWorkspace } from "../src/domain/workspace.js";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gaia-ws-order-"));
  await initWorkspace(dir);
  return dir;
}

test("workspace favorites sort first; drag-drop reorder persists across a fresh registry read", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const a = await project();
    const b = await project();
    const c = await project();
    const daemon = new Daemon({ cwd: a, log: () => {} });
    // Register in a-b-c order (registry.add prepends, so a fresh list() would
    // otherwise read c, b, a by lastOpenedAt — assert the baseline first).
    const recA = await daemon.registry.add(a);
    const recB = await daemon.registry.add(b);
    const recC = await daemon.registry.add(c);
    assert.deepEqual((await daemon.registry.list()).map((r) => r.id), [recC.id, recB.id, recA.id], "baseline: most-recently-added first");

    // Favorite C: still leads, nothing else changes yet.
    const afterFavorite = await daemon.setWorkspaceFavorite(recC.id, true);
    assert.deepEqual(afterFavorite.workspaces.map((r) => r.id), [recC.id, recB.id, recA.id]);
    assert.equal(afterFavorite.workspaces[0]!.favorite, true);

    // Favorite A too — both favorites lead the non-favorite B, ordered by the
    // same recency rule among themselves (no drag yet).
    await daemon.setWorkspaceFavorite(recA.id, true);
    let listed = await daemon.registry.list();
    assert.deepEqual(listed.map((r) => r.id), [recC.id, recA.id, recB.id]);

    // Drag-drop: put A ahead of C within the favorites, and reorder B too —
    // full desired order across every workspace.
    const reordered = await daemon.reorderWorkspaces([recA.id, recC.id, recB.id]);
    assert.deepEqual(reordered.workspaces.map((r) => r.id), [recA.id, recC.id, recB.id]);

    // Un-favorite C: it must drop below A (still favorite) but the drag order
    // among non-favorites/relative order is otherwise preserved on a fresh read.
    await daemon.setWorkspaceFavorite(recC.id, false);
    listed = await daemon.registry.list();
    assert.deepEqual(listed.map((r) => r.id), [recA.id, recC.id, recB.id], "A (favorite) leads; C and B keep their dragged relative order");
    assert.equal(listed.find((r) => r.id === recC.id)?.favorite, undefined);

    // Persistence: a brand-new Daemon/registry instance reading the same
    // GAIA_HOME sees the identical favorite + order state (real disk round-trip
    // through ~/.gaia/app.json, not just in-memory).
    const daemon2 = new Daemon({ cwd: a, log: () => {} });
    const reread = await daemon2.registry.list();
    assert.deepEqual(reread.map((r) => r.id), [recA.id, recC.id, recB.id]);
    assert.equal(reread.find((r) => r.id === recA.id)?.favorite, true);

    // Unknown id: favorite is a clean 404-shaped error, not a silent no-op.
    await assert.rejects(() => daemon.setWorkspaceFavorite("does-not-exist", true), /Unknown workspace/);
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});
