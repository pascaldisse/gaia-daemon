// The loopback egress shim that un-redacts Claude extended-thinking text by
// injecting thinking.display:"summarized" into /v1/messages requests. Driven
// against a fake upstream that records exactly what it received.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { startThinkingProxy } from "../src/harness/claude-thinking-proxy.js";

interface Recorded {
  method?: string;
  url?: string;
  auth?: string;
  body: string;
}

/** A fake Anthropic upstream: records each request, replies with a canned body.
 * `basePath` lets us mount it under a path (mirrors the credential-proxy mount). */
async function fakeUpstream(basePath = ""): Promise<{
  url: string;
  received: Recorded[];
  close: () => Promise<void>;
}> {
  const received: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers["authorization"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${basePath}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(base: string, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, text: await res.text() };
}

test("injects thinking.display:summarized into an enabled Messages request", async () => {
  const up = await fakeUpstream();
  const proxy = await startThinkingProxy(up.url);
  try {
    const res = await post(proxy.url, "/v1/messages?beta=true", JSON.stringify({ model: "claude-sonnet-5", thinking: { type: "adaptive" }, messages: [] }), {
      authorization: "Bearer oauth-token",
    });
    assert.equal(res.status, 200);
    assert.equal(res.text, JSON.stringify({ ok: true })); // response piped back verbatim
    assert.equal(up.received.length, 1);
    const sent = JSON.parse(up.received[0].body);
    assert.deepEqual(sent.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(up.received[0].url, "/v1/messages?beta=true"); // query preserved
    assert.equal(up.received[0].auth, "Bearer oauth-token"); // auth forwarded untouched
  } finally {
    proxy.close();
    await up.close();
  }
});

test("leaves a disabled thinking block alone (the API 400s on display there)", async () => {
  const up = await fakeUpstream();
  const proxy = await startThinkingProxy(up.url);
  try {
    await post(proxy.url, "/v1/messages", JSON.stringify({ thinking: { type: "disabled" }, messages: [] }));
    const sent = JSON.parse(up.received[0].body);
    assert.deepEqual(sent.thinking, { type: "disabled" }); // no display added
  } finally {
    proxy.close();
    await up.close();
  }
});

test("does not touch non-Messages requests or bodies without a thinking block", async () => {
  const up = await fakeUpstream();
  const proxy = await startThinkingProxy(up.url);
  try {
    // Non-messages path, even with a thinking block, is untouched.
    await post(proxy.url, "/v1/models", JSON.stringify({ thinking: { type: "adaptive" } }));
    // Messages path but no thinking block: passed through unchanged.
    await post(proxy.url, "/v1/messages", JSON.stringify({ messages: [] }));
    assert.deepEqual(JSON.parse(up.received[0].body).thinking, { type: "adaptive" });
    assert.equal(JSON.parse(up.received[1].body).thinking, undefined);
  } finally {
    proxy.close();
    await up.close();
  }
});

test("passes a non-JSON Messages body straight through (fails open)", async () => {
  const up = await fakeUpstream();
  const proxy = await startThinkingProxy(up.url);
  try {
    await post(proxy.url, "/v1/messages", "not json at all");
    assert.equal(up.received[0].body, "not json at all");
  } finally {
    proxy.close();
    await up.close();
  }
});

test("composes with a path-bearing upstream (credential-proxy mount)", async () => {
  const up = await fakeUpstream("/api/harness/llm");
  const proxy = await startThinkingProxy(up.url);
  try {
    await post(proxy.url, "/v1/messages?beta=true", JSON.stringify({ thinking: { type: "enabled", budget_tokens: 8000 }, messages: [] }));
    // The upstream's base path is joined ahead of the request path.
    assert.equal(up.received[0].url, "/api/harness/llm/v1/messages?beta=true");
    assert.deepEqual(JSON.parse(up.received[0].body).thinking, { type: "enabled", budget_tokens: 8000, display: "summarized" });
  } finally {
    proxy.close();
    await up.close();
  }
});
