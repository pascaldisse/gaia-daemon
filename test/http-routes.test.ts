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
    gaiaTools: [],
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
  daemon: { registry: { add(path: string): Promise<{ id: string }> }; dispose(): Promise<void> };
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
