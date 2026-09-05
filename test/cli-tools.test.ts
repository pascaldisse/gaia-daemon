import { test } from "bun:test";
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
    const summonUsage =
      "Usage: gaia summon [--worktree] <agent> <task>\n" +
      "       gaia summon --status [roomId] [--all]   census of summon lanes (state/last-event/delivered?/dirty-worktree); default room: current room";
    assert.deepEqual(output, [`${summonUsage}\nAvailable agents: gaia, ghoul-sol`, `${summonUsage}\nAvailable agents: gaia, ghoul-sol`]);
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
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
});

test("gaia summon --status (Fix #2 census): posts to /api/harness/summon/status with room or --all, defaults to GAIA_ROOM_ID", async () => {
  const previousUrl = process.env.GAIA_DAEMON_URL;
  const previousToken = process.env.GAIA_DAEMON_TOKEN;
  const previousRoom = process.env.GAIA_ROOM_ID;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousError = console.error;
  const output: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ url: string; body: unknown }> = [];

  process.env.GAIA_DAEMON_URL = "http://127.0.0.1:8787";
  process.env.GAIA_DAEMON_TOKEN = "test-token";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ result: "terry-abc  running  delivered:true" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  try {
    delete process.env.GAIA_ROOM_ID;
    assert.equal(await runHarnessCommand(["summon", "--status"]), 1, "no room in env and no roomId/--all → usage error, not a daemon call");
    assert.equal(requests.length, 0);

    process.env.GAIA_ROOM_ID = "env-room";
    assert.equal(await runHarnessCommand(["summon", "--status"]), 0);
    assert.deepEqual(requests[0], { url: "http://127.0.0.1:8787/api/harness/summon/status", body: { room: "env-room" } });

    assert.equal(await runHarnessCommand(["summon", "--status", "terry-abc"]), 0);
    assert.deepEqual(requests[1], { url: "http://127.0.0.1:8787/api/harness/summon/status", body: { room: "terry-abc" } });

    assert.equal(await runHarnessCommand(["summon", "--status", "--all"]), 0);
    assert.deepEqual(requests[2], { url: "http://127.0.0.1:8787/api/harness/summon/status", body: { all: true } });

    assert.equal(output.filter((line) => line.includes("running")).length, 3);
  } finally {
    if (previousUrl === undefined) delete process.env.GAIA_DAEMON_URL;
    else process.env.GAIA_DAEMON_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GAIA_DAEMON_TOKEN;
    else process.env.GAIA_DAEMON_TOKEN = previousToken;
    if (previousRoom === undefined) delete process.env.GAIA_ROOM_ID;
    else process.env.GAIA_ROOM_ID = previousRoom;
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    console.error = previousError;
  }
});

test("gaia archtree add-root posts the parsed task and selected agent", async () => {
  const previousUrl = process.env.GAIA_DAEMON_URL;
  const previousToken = process.env.GAIA_DAEMON_TOKEN;
  const previousAgent = process.env.GAIA_AGENT_ID;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const requests: Array<{ url: string; body: unknown }> = [];
  process.env.GAIA_DAEMON_URL = "http://127.0.0.1:8787";
  process.env.GAIA_DAEMON_TOKEN = "test-token";
  process.env.GAIA_AGENT_ID = "gaia";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ result: "Added archtree root @terry." }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  console.log = () => {};
  try {
    assert.equal(await runHarnessCommand(["archtree", "add-root", "--agent", "terry", "map", "the", "API"]), 0);
    assert.deepEqual(requests, [{ url: "http://127.0.0.1:8787/api/harness/archtree", body: { agent: "terry", task: "map the API" } }]);
  } finally {
    if (previousUrl === undefined) delete process.env.GAIA_DAEMON_URL; else process.env.GAIA_DAEMON_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GAIA_DAEMON_TOKEN; else process.env.GAIA_DAEMON_TOKEN = previousToken;
    if (previousAgent === undefined) delete process.env.GAIA_AGENT_ID; else process.env.GAIA_AGENT_ID = previousAgent;
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
});
