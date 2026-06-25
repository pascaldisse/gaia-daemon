import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { forwardLlmRequest, joinUrl, type UpstreamCredential } from "../src/app/llm-proxy.ts";
import { resolvePiUpstream } from "../src/app/pi-credential-resolver.ts";

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("joinUrl: no double or missing slashes", () => {
  assert.equal(joinUrl("https://api.deepseek.com/v1", "chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(joinUrl("https://api.deepseek.com/v1/", "/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(joinUrl("https://api.deepseek.com/v1", ""), "https://api.deepseek.com/v1");
});

test("forwardLlmRequest: injects the real key, drops the placeholder, streams the response", async () => {
  // Fake upstream: records what it received, streams an SSE-style body back.
  let seenAuth: string | undefined;
  let seenPath: string | undefined;
  let seenBody: string | undefined;
  const upstream = await listen(async (req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    seenBody = await collect(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    res.write("data: two\n\n");
    res.end();
  });

  const credential: UpstreamCredential = {
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    authHeaders: { authorization: "Bearer REAL-SECRET-KEY" },
  };

  // The proxy front: strip the leading mount path, forward the rest.
  const proxy = await listen((req, res) => {
    const subpath = (req.url ?? "/").replace(/^\/api\/harness\/llm\//, "");
    void forwardLlmRequest(req, res, credential, subpath);
  });

  const result = await fetch(`http://127.0.0.1:${proxy.port}/api/harness/llm/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer PLACEHOLDER-TOKEN", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek", stream: true }),
  });
  const text = await result.text();

  assert.equal(result.status, 200);
  assert.equal(seenAuth, "Bearer REAL-SECRET-KEY"); // injected real key...
  assert.notEqual(seenAuth, "Bearer PLACEHOLDER-TOKEN"); // ...the placeholder never reached upstream
  assert.equal(seenPath, "/v1/chat/completions"); // base + subpath joined
  assert.equal(seenBody, JSON.stringify({ model: "deepseek", stream: true })); // body forwarded intact
  assert.match(text, /data: one/);
  assert.match(text, /data: two/); // streamed through

  upstream.server.close();
  proxy.server.close();
});

test("forwardLlmRequest: fail-closed 502 when upstream is unreachable (never leaks the key)", async () => {
  const credential: UpstreamCredential = {
    baseUrl: "http://127.0.0.1:1/v1", // nothing listening
    authHeaders: { authorization: "Bearer REAL-SECRET-KEY" },
  };
  const proxy = await listen((req, res) => void forwardLlmRequest(req, res, credential, "chat/completions"));

  const result = await fetch(`http://127.0.0.1:${proxy.port}/api/harness/llm/chat/completions`, { method: "POST", body: "{}" });
  const text = await result.text();
  assert.equal(result.status, 502);
  assert.doesNotMatch(text, /REAL-SECRET-KEY/); // the key is never echoed to the caller

  proxy.server.close();
});

test("resolvePiUpstream: builds upstream from the real registry baseUrl + resolved key", async () => {
  const upstream = await resolvePiUpstream(
    { id: "a", model: { provider: "deepseek", name: "deepseek-chat" } } as never,
    {
      registry: { find: () => ({ baseUrl: "https://api.deepseek.com/v1" }) },
      authStorage: { getApiKey: async () => "sk-REAL-KEY" },
    },
  );
  assert.deepEqual(upstream, { baseUrl: "https://api.deepseek.com/v1", authHeaders: { authorization: "Bearer sk-REAL-KEY" } });
});

test("resolvePiUpstream: undefined (proxy refuses) when no key resolves — OAuth-only/unconfigured", async () => {
  const upstream = await resolvePiUpstream(
    { id: "a", model: { provider: "x", name: "y" } } as never,
    { registry: { find: () => ({ baseUrl: "https://u" }) }, authStorage: { getApiKey: async () => undefined } },
  );
  assert.equal(upstream, undefined);
});

test("resolvePiUpstream: undefined when the agent has no configured model", async () => {
  const upstream = await resolvePiUpstream({ id: "a" } as never, { registry: { find: () => undefined }, authStorage: { getApiKey: async () => "k" } });
  assert.equal(upstream, undefined);
});
