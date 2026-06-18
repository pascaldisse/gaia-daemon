import test from "node:test";
import assert from "node:assert/strict";
import { HarnessBridge } from "../src/app/harness-bridge.ts";

test("HarnessBridge round-trips claims it minted (summon allowed by default)", () => {
  const bridge = new HarnessBridge("http://127.0.0.1:8787");
  const host = bridge.hostFor("ws-1");
  const token = host.mintToken({ agentId: "gaia", roomId: "default" });

  const claims = bridge.verify(token);
  assert.deepEqual(claims, { workspaceId: "ws-1", agentId: "gaia", roomId: "default", allowSummon: true });
  assert.equal(host.baseUrl, "http://127.0.0.1:8787");
});

test("HarnessBridge mints no-summon tokens for nested (summoned) agents", () => {
  const bridge = new HarnessBridge("http://127.0.0.1:8787");
  const token = bridge.hostFor("ws-1", { allowSummon: false }).mintToken({ agentId: "scout", roomId: "default" });
  assert.deepEqual(bridge.verify(token), { workspaceId: "ws-1", agentId: "scout", roomId: "default", allowSummon: false });
});

test("HarnessBridge rejects a tampered payload", () => {
  const bridge = new HarnessBridge("http://127.0.0.1:8787");
  const token = bridge.hostFor("ws-1").mintToken({ agentId: "gaia", roomId: "default" });

  const [, signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ workspaceId: "ws-1", agentId: "admin", roomId: "default" })).toString("base64url");
  assert.equal(bridge.verify(`${forgedPayload}.${signature}`), null);
});

test("HarnessBridge rejects a token signed by a different process", () => {
  const a = new HarnessBridge("http://127.0.0.1:8787");
  const b = new HarnessBridge("http://127.0.0.1:8787");
  const token = a.hostFor("ws-1").mintToken({ agentId: "gaia", roomId: "default" });
  assert.equal(b.verify(token), null);
});

test("HarnessBridge rejects malformed or missing tokens", () => {
  const bridge = new HarnessBridge("http://127.0.0.1:8787");
  assert.equal(bridge.verify(undefined), null);
  assert.equal(bridge.verify(""), null);
  assert.equal(bridge.verify("no-dot"), null);
  assert.equal(bridge.verify("a.b.c"), null);
});
