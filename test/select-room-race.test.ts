import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GaiaWebServer } from "../src/server/http.js";
import { ensureWorkspaceRoom, initWorkspace, loadWorkspace } from "../src/domain/workspace.js";
import { registerHarness } from "../src/harness/spec.js";
import { createTempDir } from "./helpers/temp.js";

registerHarness({
  id: "pi",
  capabilities: {
    gaiaTools: ["memory", "artifact", "gaia"], nativeTools: [], granularTools: true,
    supportsPermissionMode: false, supportsMcp: false, supportsSteer: false,
    supportsCompact: false, supportsNativeCommands: false, fanOutTools: [],
  },
  ui: { label: "selection race test", description: "selection race test" },
  create: () => { throw new Error("not used: selection test never starts a turn"); },
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function select(base: string, workspaceId: string, roomId: string): Promise<Response> {
  return fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
}

test("HTTP room selection preserves invocation order, releases before response reads, and recovers after rejection", async () => {
  const temp = await createTempDir("gaia-select-race-");
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  const workspace = join(temp.path, "workspace");
  const web = new GaiaWebServer({ cwd: workspace, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    await initWorkspace(workspace);
    for (const roomId of ["first", "latest", "slow-read", "read-winner", "recovered"]) {
      await ensureWorkspaceRoom(workspace, roomId);
    }
    live = await web.listen();
    const daemon = (web as unknown as {
      daemon: {
        registry: {
          add(path: string): Promise<{ id: string }>;
          find(id: string): Promise<unknown>;
        };
        files: { listWorkspace(id: string): Promise<unknown> };
        currentRoom: Map<string, string>;
        selectRoom(workspaceId: string, roomId: string, opts?: { incognito?: boolean }): Promise<unknown>;
        subscribe(listener: (event: unknown) => void): () => void;
      };
    }).daemon;
    const record = await daemon.registry.add(workspace);
    const base = live.url.replace(/\/$/, "");

    // Observe entry into selectRoom itself: the second request is enqueued before
    // the first lookup is released, rather than merely sitting in the HTTP stack.
    const originalSelect = daemon.selectRoom.bind(daemon);
    let selectCalls = 0;
    let secondInvoked = deferred();
    daemon.selectRoom = (...args) => {
      const result = originalSelect(...args);
      selectCalls += 1;
      if (selectCalls === 2) secondInvoked.resolve();
      return result;
    };

    const originalFind = daemon.registry.find.bind(daemon.registry);
    const firstFindEntered = deferred();
    const releaseFirstFind = deferred();
    let findCalls = 0;
    daemon.registry.find = async (id) => {
      findCalls += 1;
      if (findCalls === 1) {
        firstFindEntered.resolve();
        await releaseFirstFind.promise;
      }
      return originalFind(id);
    };

    const firstResponse = select(base, record.id, "first");
    await firstFindEntered.promise;
    const latestResponse = select(base, record.id, "latest");
    await secondInvoked.promise;
    releaseFirstFind.resolve();
    assert.equal((await firstResponse).status, 200);
    assert.equal((await latestResponse).status, 200);
    assert.equal((await loadWorkspace(workspace)).config.room, "latest");
    assert.equal(daemon.currentRoom.get(record.id), "latest");

    // Once persistence/current-room mutation finishes, response-only reads no
    // longer own the queue. A newer selection can finish while the old response
    // remains held, and only the newest request may broadcast navigation.
    daemon.registry.find = originalFind;
    const originalListWorkspace = daemon.files.listWorkspace.bind(daemon.files);
    const slowReadEntered = deferred();
    const releaseSlowRead = deferred();
    let listCalls = 0;
    daemon.files.listWorkspace = async (id) => {
      listCalls += 1;
      if (listCalls === 1) {
        slowReadEntered.resolve();
        await releaseSlowRead.promise;
      }
      return originalListWorkspace(id);
    };
    const broadcasts: Array<{ type?: string; roomId?: string }> = [];
    const unsubscribe = daemon.subscribe((event) => broadcasts.push(event as { type?: string; roomId?: string }));

    const slowResponse = select(base, record.id, "slow-read");
    await slowReadEntered.promise;
    const winnerResponse = await select(base, record.id, "read-winner");
    assert.equal(winnerResponse.status, 200, await winnerResponse.text());
    assert.equal((await loadWorkspace(workspace)).config.room, "read-winner");
    assert.equal(daemon.currentRoom.get(record.id), "read-winner");
    releaseSlowRead.resolve();
    assert.equal((await slowResponse).status, 200);
    assert.deepEqual(
      broadcasts.filter((event) => event.type === "snapshot").map((event) => event.roomId),
      ["read-winner"],
    );
    unsubscribe();
    daemon.files.listWorkspace = originalListWorkspace;

    // A rejected head mutation must settle the tail so the next invocation runs.
    let rejectNextFind = true;
    daemon.registry.find = async (id) => {
      if (rejectNextFind) {
        rejectNextFind = false;
        throw new Error("held selection failed");
      }
      return originalFind(id);
    };
    const rejected = select(base, record.id, "first");
    const recovered = select(base, record.id, "recovered");
    assert.equal((await rejected).status, 400);
    assert.equal((await recovered).status, 200);
    assert.equal((await loadWorkspace(workspace)).config.room, "recovered");
    assert.equal(daemon.currentRoom.get(record.id), "recovered");
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
