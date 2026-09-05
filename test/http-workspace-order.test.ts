// Real HTTP surface for the sidebar "reorder by drag/drop + favorites always
// on top" feature: POST /api/workspaces/:id/favorite and
// POST /api/workspaces/reorder against a live GaiaWebServer, unauthenticated
// (legacy shared scope — the ownership gate that /favorite sits behind, and
// the pre-gate placement of /reorder, both get exercised for real).
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GaiaWebServer } from "../src/server/http.js";
import { registerHarness } from "../src/harness/spec.js";
import { createTempDir } from "./helpers/temp.js";

registerHarness({
  id: "pi",
  capabilities: {
    gaiaTools: [], nativeTools: [], granularTools: true, supportsPermissionMode: false,
    supportsMcp: false, supportsSteer: false, supportsCompact: false,
    supportsNativeCommands: false, fanOutTools: [],
  },
  ui: { label: "HTTP workspace order test", description: "live endpoint test harness" },
  create: () => { throw new Error("not used: workspace order test never starts a turn"); },
});

interface WorkspaceRecord { id: string; path: string; favorite?: boolean }
interface AppPayload { workspaces: WorkspaceRecord[] }

async function json<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  return { status: response.status, body: (await response.json()) as T };
}

test("live daemon: POST .../favorite pins to the top, POST .../reorder persists a drag-drop order", async () => {
  const temp = await createTempDir("gaia-http-ws-order-");
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "gaia-home");
  const web = new GaiaWebServer({ cwd: temp.path, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    live = await web.listen();
    const base = live.url.replace(/\/$/, "");

    const paths = [join(temp.path, "ws-a"), join(temp.path, "ws-b"), join(temp.path, "ws-c")];
    const ids: string[] = [];
    for (const p of paths) {
      const created = await mkdtemp(p);
      const added = await json<AppPayload & { currentWorkspaceId: string }>(base, "/api/workspaces", { method: "POST", body: JSON.stringify({ path: created }) });
      assert.equal(added.status, 200);
      ids.push(added.body.currentWorkspaceId);
    }
    const [aId, bId, cId] = ids;

    // Baseline from /api/app: most-recently-added first (c, b, a).
    const baseline = await json<AppPayload>(base, "/api/app");
    assert.deepEqual(baseline.body.workspaces.map((w) => w.id), [cId, bId, aId]);

    // Favorite A — jumps to the top over c/b despite being least-recent.
    const favorited = await json<{ workspaces: WorkspaceRecord[] }>(base, `/api/workspaces/${aId}/favorite`, { method: "POST", body: JSON.stringify({ favorite: true }) });
    assert.equal(favorited.status, 200);
    assert.deepEqual(favorited.body.workspaces.map((w) => w.id), [aId, cId, bId]);
    assert.equal(favorited.body.workspaces[0]!.favorite, true);

    // Drag-drop: reorder to b, a, c — favorite still pins a ahead of c, but
    // relative order among the rest reflects the drop.
    const reordered = await json<{ workspaces: WorkspaceRecord[] }>(base, "/api/workspaces/reorder", { method: "POST", body: JSON.stringify({ ids: [bId, aId, cId] }) });
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.body.workspaces.map((w) => w.id), [aId, bId, cId], "favorite (a) still leads; b now ahead of c per the drop");

    // Unknown/foreign workspace id is covered at the daemon layer (see
    // workspace-registry-order.test.ts) — not re-tested through the live HTTP
    // ownership gate here: that gate 403s without draining the request body,
    // which is a pre-existing Node http quirk (reproduces on other existing
    // parameterized workspace routes too, e.g. POST .../rooms) that leaves the
    // keep-alive socket open and hangs this test's live.close() forever —
    // unrelated to this feature, out of scope to fix here.

    // A fresh /api/app read confirms the order survived the round trip.
    const reread = await json<AppPayload>(base, "/api/app");
    assert.deepEqual(reread.body.workspaces.map((w) => w.id), [aId, bId, cId]);
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
