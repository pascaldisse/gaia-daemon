// The thinking-proxy's stall net: an upstream that CONNECTS but never answers
// (no response headers) or that starts a response then goes silent mid-body
// must be declared wedged and surfaced via `onStall`, not just left to hang.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { startThinkingProxy } from "../src/harness/claude-thinking-proxy.js";

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("upstream never sends response headers -> onStall fires with 'no response headers'", async () => {
  // Accepts the request but never responds — the connection just hangs.
  const up = http.createServer((req) => {
    req.on("data", () => {});
  });
  await new Promise<void>((resolve) => up.listen(0, "127.0.0.1", resolve));
  const port = (up.address() as AddressInfo).port;

  const calls: string[] = [];
  const proxy = await startThinkingProxy(`http://127.0.0.1:${port}`, {
    stallMs: 200,
    onStall: (text) => calls.push(text),
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    // The header-stall net destroys uReq before headers arrive; failLoud then
    // writes an Anthropic-shaped 502 back since cRes hasn't sent headers yet.
    assert.equal(res.status, 502);
    await res.text().catch(() => undefined);

    await waitFor(() => calls.length > 0, 2000);
    assert.ok(calls.length >= 1, "onStall should have fired");
    assert.match(calls[0], /no response headers/);
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => up.close(() => resolve()));
  }
});

test("upstream sends headers + one chunk then goes silent -> onStall fires with 'stalled'", async () => {
  const up = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("chunk-1");
      // Never res.end() or write again — the body just goes silent.
    });
  });
  await new Promise<void>((resolve) => up.listen(0, "127.0.0.1", resolve));
  const port = (up.address() as AddressInfo).port;

  const calls: string[] = [];
  const proxy = await startThinkingProxy(`http://127.0.0.1:${port}`, {
    stallMs: 200,
    onStall: (text) => calls.push(text),
  });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(res.status, 200);
    // Reading to completion may reject once the stall net destroys the
    // sockets — that IS the behavior under test (a wedged body surfaces via
    // onStall instead of hanging the client forever).
    await res.text().catch(() => undefined);

    await waitFor(() => calls.length > 0, 2000);
    assert.ok(calls.length >= 1, "onStall should have fired");
    assert.match(calls[0], /stalled/);
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => up.close(() => resolve()));
  }
});
