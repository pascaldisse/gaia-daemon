import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { RoomHandle } from "../src/domain/rooms.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { registerHarness } from "../src/harness/spec.js";
import { GaiaWebServer } from "../src/server/http.js";
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
  daemon: {
    registry: { add(path: string): Promise<{ id: string }> };
    dispose(): Promise<void>;
  };
};

async function listenRoute(web: WebInternals): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = createServer((request, response) => {
    void web.handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeAllConnections?.();
}

test("background-task output endpoint serves the last 16KB and 404s unknown or missing files", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  let web: WebInternals | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);
    const outputPath = join(temp.path, "task.output");
    const output = `${"old-output\n".repeat(2000)}${"tail-output\n".repeat(1000)}`;
    await writeFile(outputPath, output, "utf8");

    const room = await RoomHandle.open(workspace, "default");
    await room.updateState((state) => {
      state.backgroundTasks = [
        {
          taskId: "bg-present",
          toolName: "Bash",
          command: "long command",
          outputPath,
          startedAt: new Date().toISOString(),
          agentId: "gaia",
          roomId: "default",
        },
        {
          taskId: "bg-missing-file",
          toolName: "Bash",
          outputPath: join(temp.path, "missing.output"),
          startedAt: new Date().toISOString(),
          agentId: "gaia",
          roomId: "default",
        },
      ];
    });

    web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const record = await web.daemon.registry.add(workspace);
    const listening = await listenRoute(web);
    server = listening.server;
    const route = `${listening.baseUrl}/api/workspaces/${encodeURIComponent(record.id)}/rooms/default/background-tasks`;

    const found = await fetch(`${route}/bg-present/output`);
    assert.equal(found.status, 200);
    const body = await found.json() as { text: string; running: boolean };
    assert.equal(body.text, Buffer.from(output).subarray(-16 * 1024).toString("utf8"));
    // The file was written and closed above — no process still holds it open.
    assert.equal(body.running, false);

    const unknown = await fetch(`${route}/bg-unknown/output`);
    assert.equal(unknown.status, 404);
    const missing = await fetch(`${route}/bg-missing-file/output`);
    assert.equal(missing.status, 404);
  } finally {
    if (server) await closeServer(server);
    await web?.daemon.dispose();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});

test("DELETE background-tasks stops/dismisses a known task and 404s an unknown id", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  let web: WebInternals | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);

    const room = await RoomHandle.open(workspace, "default");
    await room.updateState((state) => {
      state.backgroundTasks = [
        { taskId: "bg-stop", toolName: "Bash", startedAt: new Date().toISOString(), agentId: "gaia", roomId: "default" },
      ];
    });

    web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const record = await web.daemon.registry.add(workspace);
    const listening = await listenRoute(web);
    server = listening.server;
    const route = `${listening.baseUrl}/api/workspaces/${encodeURIComponent(record.id)}/rooms/default/background-tasks`;

    const unknown = await fetch(`${route}/bg-unknown`, { method: "DELETE" });
    assert.equal(unknown.status, 404);

    const stopped = await fetch(`${route}/bg-stop`, { method: "DELETE" });
    assert.equal(stopped.status, 200);
    const body = await stopped.json() as { ok: boolean };
    assert.equal(body.ok, true);

    const after = await RoomHandle.open(workspace, "default");
    assert.deepEqual((await after.state()).backgroundTasks ?? [], []);
  } finally {
    if (server) await closeServer(server);
    await web?.daemon.dispose();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
