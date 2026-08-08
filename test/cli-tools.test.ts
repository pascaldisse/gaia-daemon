import test from "node:test";
import assert from "node:assert/strict";
import { runHarnessCommand } from "../src/services/cli-tools.js";

test("gaia summon with no args and --help prints usage plus the daemon roster", async () => {
  const previousUrl = process.env.GAIA_DAEMON_URL;
  const previousToken = process.env.GAIA_DAEMON_TOKEN;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const output: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.GAIA_DAEMON_URL = "http://127.0.0.1:8787";
  process.env.GAIA_DAEMON_TOKEN = "test-token";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ agents: [{ id: "gaia", label: "Gaia" }, { id: "ghoul-sol", label: "Ghoul Sol" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  console.log = (...args: unknown[]) => output.push(args.join(" "));

  try {
    assert.equal(await runHarnessCommand(["summon", "--help"]), 0);
    assert.equal(await runHarnessCommand(["summon"]), 1);
    assert.deepEqual(output, [
      "Usage: gaia summon [--worktree] <agent> <task>\nAvailable agents: gaia, ghoul-sol",
      "Usage: gaia summon [--worktree] <agent> <task>\nAvailable agents: gaia, ghoul-sol",
    ]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, "http://127.0.0.1:8787/api/harness/agents");
      assert.equal(request.init?.method, "GET");
      assert.equal(new Headers(request.init?.headers).get("authorization"), "Bearer test-token");
    }
  } finally {
    if (previousUrl === undefined) delete process.env.GAIA_DAEMON_URL;
    else process.env.GAIA_DAEMON_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GAIA_DAEMON_TOKEN;
    else process.env.GAIA_DAEMON_TOKEN = previousToken;
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
});
