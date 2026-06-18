import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startWebServer } from "../src/web/server.ts";
import { initWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

// The full happy path (valid token -> mutate) is covered piecewise by the
// cli-harness, harness-bridge, and gaia-controller tests. Here we confirm the
// endpoints are wired into the running daemon and reject unauthenticated calls.
test("harness endpoints are routed and reject missing/invalid tokens", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const server = await startWebServer({ cwd: temp.path, host: "127.0.0.1", port: 0 });
    const base = server.url.replace(/\/$/, "");

    try {
      const noToken = await fetch(`${base}/api/harness/memory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", content: "x" }),
      });
      assert.equal(noToken.status, 401);

      const badToken = await fetch(`${base}/api/harness/summon`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
        body: JSON.stringify({ agent: "gaia", task: "do something" }),
      });
      assert.equal(badToken.status, 401);
    } finally {
      await server.close();
    }
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});
