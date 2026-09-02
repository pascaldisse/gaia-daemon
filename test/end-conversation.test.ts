import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GaiaWebServer } from "../src/server/http.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { createTempDir } from "./helpers/temp.js";
import "../src/harness/index.js";

test("live harness end-conversation endpoint writes a farewell scoped to its bearer-token room", async () => {
  const temp = await createTempDir("gaia-end-conversation-");
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  const workspace = join(temp.path, "workspace");
  const web = new GaiaWebServer({ cwd: workspace, host: "127.0.0.1", port: 0 });
  let live: Awaited<ReturnType<GaiaWebServer["listen"]>> | undefined;
  try {
    await initWorkspace(workspace);
    live = await web.listen();
    const daemon = (web as unknown as { daemon: any }).daemon;
    const record = await daemon.registry.add(workspace);
    const token = daemon.bridge.hostFor(record.id).mintToken({ agentId: "gaia", roomId: "default" });
    const response = await fetch(`${live.url.replace(/\/$/, "")}/api/harness/end-conversation`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ farewell: "Goodbye from the live endpoint." }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ok: boolean }).ok, true);
    const service = await daemon.serviceFor(record.id, "default");
    const { events } = await service.room.eventsFrom(0);
    assert.equal(events.at(-1)?.author, "gaia");
    assert.equal(events.at(-1)?.text, "Goodbye from the live endpoint.");
    assert.ok((await service.room.state()).conversationEndedAgents?.gaia);
  } finally {
    await live?.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
