import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GaiaWebServer } from "../src/server/http.js";
import { workspacePaths } from "../src/core/paths.js";
import { registerHarness } from "../src/harness/spec.js";
import { createTempDir } from "./helpers/temp.js";

registerHarness({
  id: "pi",
  capabilities: {
    gaiaTools: [], nativeTools: [], granularTools: true, supportsPermissionMode: false,
    supportsMcp: false, supportsSteer: false, supportsCompact: false,
    supportsNativeCommands: false, fanOutTools: [],
  },
  ui: { label: "HTTP workspace scope test", description: "live endpoint test harness" },
  create: () => { throw new Error("not used: workspace scope test never starts a turn"); },
});

interface AppPayload {
  workspaces: Array<{ id: string; path: string }>;
}

async function jsonRequest<T>(base: string, path: string, init?: RequestInit, cookie?: string): Promise<{ status: number; body: T; cookie?: string }> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  return {
    status: response.status,
    body: await response.json() as T,
    ...(response.headers.get("set-cookie") ? { cookie: response.headers.get("set-cookie")!.split(";", 1)[0] } : {}),
  };
}

test("live scratch daemon isolates two assigned human workspace and room graphs", async () => {
  const temp = await createTempDir("gaia-http-user-workspaces-");
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "gaia-home");
  const aliceWorkspace = join(temp.path, "humans", "alice", "workspace");
  const bobWorkspace = join(temp.path, "humans", "bob", "workspace");
  const web = new GaiaWebServer({ cwd: temp.path, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    live = await web.listen();
    const base = live.url.replace(/\/$/, "");

    const aliceRegistered = await jsonRequest<{ user: { id: string } }>(base, "/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "correct horse battery staple", home: join(temp.path, "humans", "alice"), workspace: aliceWorkspace }),
    });
    assert.equal(aliceRegistered.status, 200);

    const aliceLogin = await jsonRequest<{ user: { id: string } }>(base, "/api/auth/login", {
      method: "POST", body: JSON.stringify({ username: "alice", password: "correct horse battery staple" }),
    });
    assert.equal(aliceLogin.status, 200);
    assert.ok(aliceLogin.cookie);

    const bobRegistered = await jsonRequest<{ user: { id: string } }>(base, "/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "correct horse battery staple", home: join(temp.path, "humans", "bob"), workspace: bobWorkspace }),
    }, aliceLogin.cookie);
    assert.equal(bobRegistered.status, 200);

    const bobLogin = await jsonRequest<{ user: { id: string } }>(base, "/api/auth/login", {
      method: "POST", body: JSON.stringify({ username: "bob", password: "correct horse battery staple" }),
    });
    assert.equal(bobLogin.status, 200);
    assert.ok(bobLogin.cookie);

    const aliceApp = await jsonRequest<AppPayload>(base, "/api/app", undefined, aliceLogin.cookie);
    const bobApp = await jsonRequest<AppPayload>(base, "/api/app", undefined, bobLogin.cookie);
    assert.equal(aliceApp.status, 200);
    assert.equal(bobApp.status, 200);
    assert.deepEqual(aliceApp.body.workspaces.map((workspace) => workspace.path), [aliceWorkspace]);
    assert.deepEqual(bobApp.body.workspaces.map((workspace) => workspace.path), [bobWorkspace]);
    const aliceId = aliceApp.body.workspaces[0]!.id;
    const bobId = bobApp.body.workspaces[0]!.id;
    assert.notEqual(aliceId, bobId);

    const createdRoom = await jsonRequest(base, `/api/workspaces/${aliceId}/rooms`, {
      method: "POST", body: JSON.stringify({ roomId: "alice-private" }),
    }, aliceLogin.cookie);
    assert.equal(createdRoom.status, 200);
    assert.ok(existsSync(workspacePaths.roomDir(aliceWorkspace, "alice-private")));
    assert.equal(existsSync(workspacePaths.roomDir(bobWorkspace, "alice-private")), false);

    const foreignSnapshot = await jsonRequest<{ error: string }>(base, `/api/workspaces/${aliceId}/snapshot`, undefined, bobLogin.cookie);
    assert.equal(foreignSnapshot.status, 403);
    assert.match(foreignSnapshot.body.error, /assigned scope/);
    const foreignSearch = await jsonRequest<{ error: string }>(base, `/api/search?q=anything&workspace=${aliceId}`, undefined, bobLogin.cookie);
    assert.equal(foreignSearch.status, 403);
    assert.match(foreignSearch.body.error, /assigned scope/);
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
