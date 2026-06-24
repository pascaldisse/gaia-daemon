import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { BridgeMemoryStore, bridgeSummonCreate } from "../src/runtime/bridge-deps.ts";

interface Captured {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

async function withFakeDaemon(
  handler: (captured: Captured) => { status: number; payload: unknown },
  run: (target: { url: string; token: string }, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const entry: Captured = { path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} };
      captured.push(entry);
      const { status, payload } = handler(entry);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    await run({ url: `http://127.0.0.1:${port}`, token: "test-token" }, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("BridgeMemoryStore.mutate posts to the daemon with the bearer token", async () => {
  await withFakeDaemon(
    () => ({ status: 200, payload: { ok: true, message: "add complete", result: "OK: add complete" } }),
    async (target, captured) => {
      const store = new BridgeMemoryStore(target);
      const result = await store.mutate("/tmp/does-not-exist", "MEMORY.md", "add", { content: "remember this" });
      assert.equal(result.ok, true);
      assert.equal(result.message, "add complete");
      assert.equal(captured[0].path, "/api/harness/memory");
      assert.equal(captured[0].auth, "Bearer test-token");
      assert.equal(captured[0].body.action, "add");
      assert.equal(captured[0].body.content, "remember this");
    },
  );
});

test("BridgeMemoryStore.mutate reports a rejection from the daemon", async () => {
  await withFakeDaemon(
    () => ({ status: 200, payload: { ok: false, message: "looks like a secret", result: "ERROR: looks like a secret" } }),
    async (target) => {
      const store = new BridgeMemoryStore(target);
      const result = await store.mutate("/tmp/does-not-exist", "MEMORY.md", "add", { content: "x" });
      assert.equal(result.ok, false);
      assert.equal(result.message, "looks like a secret");
    },
  );
});

test("bridgeSummonCreate posts the agent + task and returns the reply", async () => {
  await withFakeDaemon(
    () => ({ status: 200, payload: { result: "### @whale-flash\ndone" } }),
    async (target, captured) => {
      const summon = bridgeSummonCreate(target);
      const reply = await summon({ roomId: "default", agentId: "whale-flash", task: "do the thing" });
      assert.equal(reply, "### @whale-flash\ndone");
      assert.equal(captured[0].path, "/api/harness/summon");
      assert.equal(captured[0].body.agent, "whale-flash");
      assert.equal(captured[0].body.task, "do the thing");
    },
  );
});

test("bridgeSummonCreate throws on a daemon error", async () => {
  await withFakeDaemon(
    () => ({ status: 403, payload: { error: "Summoned agents cannot summon." } }),
    async (target) => {
      const summon = bridgeSummonCreate(target);
      await assert.rejects(() => summon({ roomId: "r", agentId: "a", task: "t" }), /cannot summon/);
    },
  );
});
