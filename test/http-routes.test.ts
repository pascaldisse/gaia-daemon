import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { GaiaWebServer } from "../src/server/http.js";
import { artifactRoutePrefix } from "../src/server/routes/artifacts.js";
import { titleCaseId } from "../src/server/routes/agents.js";
import { stringArrayField } from "../src/server/routes/edit-retry.js";
import { numberField } from "../src/server/routes/memory.js";
import { attachmentRefs } from "../src/server/routes/rooms.js";
import { summonCensusText } from "../src/server/routes/usage.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { RoomHandle } from "../src/domain/rooms.js";
import { registerHarness } from "../src/harness/spec.js";
import { createTempDir } from "./helpers/temp.js";

registerHarness({
  id: "pi",
  capabilities: {
    gaiaTools: ["memory", "artifact", "gaia"],
    nativeTools: [],
    granularTools: true,
    supportsPermissionMode: false,
    supportsMcp: false,
    supportsSteer: false,
    supportsCompact: false,
    supportsNativeCommands: false,
    fanOutTools: [],
  },
  ui: { label: "HTTP test", description: "endpoint test harness" },
  create: () => {
    throw new Error("not used: endpoint test never starts a turn");
  },
});

type WebInternals = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  daemon: {
    registry: { add(path: string): Promise<{ id: string }> };
    pluginRegistry: { current: { generation: number } };
    dispose(): Promise<void>;
  };
};
async function listenRoute(web: WebInternals): Promise<{ server: HttpServer; base: string }> {
  const server = createServer((request, response) => void web.handle(request, response));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
test("route modules preserve parsing contracts and API auth JSON", async () => {
  assert.equal(titleCaseId("my-agent"), "My Agent");
  assert.deepEqual(stringArrayField({ keepAttachments: [] }, "keepAttachments"), []);
  assert.equal(numberField({ limit: 3 }, "limit"), 3);
  assert.deepEqual(attachmentRefs({ attachments: [{ id: "file-1", name: "x" }] }), [{ id: "file-1", name: "x" }]);
  assert.equal(summonCensusText([]), "No summon lanes found.");
  assert.equal(artifactRoutePrefix, "/api/harness/tools");
  const temp = await createTempDir();
  const web = new GaiaWebServer({ cwd: temp.path }) as unknown as WebInternals;
  const { server, base } = await listenRoute(web);
  try {
    const response = await fetch(`${base}/api/auth/users`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Not logged in." });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await web.daemon.dispose();
    await temp.cleanup();
  }
});

test("plugins reload endpoint stages and swaps immediately when no turn holds a lease", async () => {
  const temp = await createTempDir();
  const web = new GaiaWebServer({ cwd: temp.path }) as unknown as WebInternals;
  const { server, base } = await listenRoute(web);
  try {
    const response = await fetch(`${base}/api/plugins/reload`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "staged");
    assert.ok(web.daemon.pluginRegistry.current.generation > 0, "POST reload swaps without a settings-file reload");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await web.daemon.dispose();
    await temp.cleanup();
  }
});

test("rooms domain: POST title renames the room, GET events returns its shape", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  let web: WebInternals | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);
    await RoomHandle.open(workspace, "default");
    web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const record = await web.daemon.registry.add(workspace);
    const { server: listeningServer, base } = await listenRoute(web);
    server = listeningServer;
    const roomRoute = `${base}/api/workspaces/${encodeURIComponent(record.id)}/rooms/default`;

    const renamed = await fetch(`${roomRoute}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Room" }),
    });
    assert.equal(renamed.status, 200);

    const events = await fetch(`${roomRoute}/events`);
    assert.equal(events.status, 200);
    const body = (await events.json()) as { events: unknown[] };
    assert.ok(Array.isArray(body.events));

    const missingTitle = await fetch(`${roomRoute}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingTitle.status, 400);
    assert.deepEqual(await missingTitle.json(), { error: "Missing room title" });
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    await web?.daemon.dispose();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});

test("agents domain: POST /api/agents scaffolds a global agent, missing id is 400", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  let web: WebInternals | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);
    web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const { server: listeningServer, base } = await listenRoute(web);
    server = listeningServer;

    const missing = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "Missing agent id" });

    const created = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "test-agent" }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { agent: { id: string; displayName: string } };
    assert.equal(body.agent.id, "test-agent");
    assert.equal(body.agent.displayName, "Test Agent");
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    await web?.daemon.dispose();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});

test("artifacts domain: POST /api/harness/tools artifact-create then artifact-list round-trips", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  const workspace = join(temp.path, "workspace");
  const web = new GaiaWebServer({ cwd: workspace, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    await initWorkspace(workspace);
    live = await web.listen();
    const internals = web as unknown as {
      daemon: {
        registry: { add(path: string): Promise<{ id: string }> };
        bridge: { hostFor(workspaceId: string): { mintToken(claims: { agentId: string; roomId: string }): string } };
      };
    };
    const record = await internals.daemon.registry.add(workspace);
    const base = live.url.replace(/\/$/, "");
    const token = internals.daemon.bridge.hostFor(record.id).mintToken({ agentId: "gaia", roomId: "default" });

    const created = await fetch(`${base}/api/harness/tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "artifact-create", name: "note", kind: "json", mediaType: "application/json", payload: "{}" }),
    });
    const createdBody = (await created.json()) as { ok: boolean; result: { artifactId: string } };
    assert.equal(created.status, 200, JSON.stringify(createdBody));
    assert.equal(createdBody.ok, true, JSON.stringify(createdBody));
    assert.ok(createdBody.result.artifactId);

    const listed = await fetch(`${base}/api/harness/tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "artifact-list" }),
    });
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { ok: boolean; result: Array<{ artifactId: string }> };
    assert.ok(listedBody.result.some((a) => a.artifactId === createdBody.result.artifactId));

    const badOp = await fetch(`${base}/api/harness/tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "not-a-real-op" }),
    });
    assert.equal(badOp.status, 400);
    assert.deepEqual(await badOp.json(), { error: "unknown tool operation" });

    const unauthorized = await fetch(`${base}/api/harness/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "artifact-list" }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});

test("usage domain: POST /api/usage/refresh returns an accounts snapshot", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  let web: WebInternals | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);
    web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const { server: listeningServer, base } = await listenRoute(web);
    server = listeningServer;

    const refreshed = await fetch(`${base}/api/usage/refresh`, { method: "POST" });
    assert.equal(refreshed.status, 200);
    const body = (await refreshed.json()) as { accounts: Record<string, unknown> };
    assert.equal(typeof body.accounts, "object");

    const wrongMethod = await fetch(`${base}/api/usage/refresh`, { method: "GET" });
    assert.equal(wrongMethod.status, 404);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    await web?.daemon.dispose();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});

test("edit-retry domain: POST .../retry regenerates, missing eventId is 400", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  const workspace = join(temp.path, "workspace");
  const web = new GaiaWebServer({ cwd: workspace, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    await initWorkspace(workspace);
    await RoomHandle.open(workspace, "default");
    live = await web.listen();
    const internals = web as unknown as { daemon: { registry: { add(path: string): Promise<{ id: string }> } } };
    const record = await internals.daemon.registry.add(workspace);
    const base = live.url.replace(/\/$/, "");
    const route = `${base}/api/workspaces/${encodeURIComponent(record.id)}/rooms/default/retry`;

    const missing = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "Missing eventId" });

    const unknownEvent = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "does-not-exist" }),
    });
    assert.equal(unknownEvent.status, 409);
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});

test("memory domain: GET workspace memory/status shape, POST harness memory writes MEMORY.md", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  const workspace = join(temp.path, "workspace");
  const web = new GaiaWebServer({ cwd: workspace, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    await initWorkspace(workspace);
    live = await web.listen();
    const internals = web as unknown as {
      daemon: {
        registry: { add(path: string): Promise<{ id: string }> };
        bridge: { hostFor(workspaceId: string): { mintToken(claims: { agentId: string; roomId: string }): string } };
      };
    };
    const record = await internals.daemon.registry.add(workspace);
    const base = live.url.replace(/\/$/, "");

    const statusRes = await fetch(`${base}/api/workspaces/${encodeURIComponent(record.id)}/memory/status`);
    assert.equal(statusRes.status, 200);
    assert.ok("health" in (await statusRes.json() as Record<string, unknown>));

    const token = internals.daemon.bridge.hostFor(record.id).mintToken({ agentId: "gaia", roomId: "default" });
    const writeRes = await fetch(`${base}/api/harness/memory`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "add", content: "remember this" }),
    });
    assert.equal(writeRes.status, 200);
    const writeBody = (await writeRes.json()) as { ok: boolean; result: string };
    assert.equal(writeBody.ok, true);
    assert.match(writeBody.result, /remember this/);

    const unauthorized = await fetch(`${base}/api/harness/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", content: "nope" }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
