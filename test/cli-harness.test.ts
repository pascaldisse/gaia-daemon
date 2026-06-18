import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/memory-store.ts";
import { runHarnessCommand } from "../src/cli-harness.ts";
import { createTempDir } from "./helpers/temp.ts";

// Capture console.log output while running a harness command.
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const original = console.log;
  const originalErr = console.error;
  let out = "";
  console.log = (...parts: unknown[]) => {
    out += `${parts.join(" ")}\n`;
  };
  console.error = (...parts: unknown[]) => {
    out += `${parts.join(" ")}\n`;
  };
  try {
    const code = await runHarnessCommand(args);
    return { code, out: out.trim() };
  } finally {
    console.log = original;
    console.error = originalErr;
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

test("gaia mem list and read work straight off disk", async () => {
  const temp = await createTempDir();
  try {
    const memDir = join(temp.path, "memory");
    await new MemoryStore().init(memDir, "Gaia");
    await writeFile(join(memDir, "MEMORY.md"), "# Gaia Memory\n\nremember the latency target\n", "utf8");

    await withEnv({ GAIA_MEMORY_DIR: memDir }, async () => {
      const list = await run(["mem", "list"]);
      assert.equal(list.code, 0);
      assert.match(list.out, /MEMORY\.md/);

      const read = await run(["mem", "read"]);
      assert.equal(read.code, 0);
      assert.match(read.out, /latency target/);
    });
  } finally {
    await temp.cleanup();
  }
});

test("gaia recall searches the room transcript off disk", async () => {
  const temp = await createTempDir();
  try {
    const roomDir = join(temp.path, "rooms", "default");
    await mkdir(roomDir, { recursive: true });
    await writeFile(
      join(roomDir, "transcript.jsonl"),
      `${JSON.stringify({ id: "e1", timestamp: "2026-06-12T10:00:00.000Z", author: "gaia", text: "the latency budget is 500ms" })}\n`,
      "utf8",
    );

    await withEnv({ GAIA_ROOM_DIR: roomDir }, async () => {
      const hit = await run(["recall", "latency"]);
      assert.equal(hit.code, 0);
      assert.match(hit.out, /latency budget/);

      const miss = await run(["recall", "nonexistentterm"]);
      assert.equal(miss.code, 0);
      assert.match(miss.out, /no matches/);
    });
  } finally {
    await temp.cleanup();
  }
});

test("gaia mem add posts to the daemon with the bearer token", async () => {
  const requests: Array<{ url?: string; auth?: string; body: unknown }> = [];
  const server: Server = createServer(async (request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization, body: await body(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: "OK: add complete" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await withEnv({ GAIA_DAEMON_URL: `http://127.0.0.1:${port}`, GAIA_DAEMON_TOKEN: "tok-123" }, async () => {
      const result = await run(["mem", "add", "a new durable fact"]);
      assert.equal(result.code, 0);
      assert.match(result.out, /OK: add complete/);
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "/api/harness/memory");
    assert.equal(requests[0]?.auth, "Bearer tok-123");
    assert.deepEqual(requests[0]?.body, { action: "add", file: "MEMORY.md", content: "a new durable fact", old_text: "" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("gaia summon posts the target agent and task to the daemon", async () => {
  const requests: Array<{ url?: string; body: unknown }> = [];
  const server: Server = createServer(async (request, response) => {
    requests.push({ url: request.url, body: await body(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: "worker summary" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await withEnv({ GAIA_DAEMON_URL: `http://127.0.0.1:${port}`, GAIA_DAEMON_TOKEN: "tok-1" }, async () => {
      const result = await run(["summon", "scout", "research", "the", "topic"]);
      assert.equal(result.code, 0);
      assert.match(result.out, /worker summary/);
    });

    assert.equal(requests[0]?.url, "/api/harness/summon");
    assert.deepEqual(requests[0]?.body, { agent: "scout", task: "research the topic" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("gaia mem add fails clearly without a daemon", async () => {
  await withEnv({ GAIA_DAEMON_URL: undefined, GAIA_DAEMON_TOKEN: undefined }, async () => {
    const result = await run(["mem", "add", "something"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /needs the GAIA daemon/);
  });
});

test("gaia mem replace requires --old", async () => {
  await withEnv({ GAIA_DAEMON_URL: "http://127.0.0.1:1", GAIA_DAEMON_TOKEN: "x" }, async () => {
    const result = await run(["mem", "replace", "new text"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /--old is required/);
  });
});
