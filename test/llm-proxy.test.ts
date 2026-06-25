import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { forwardLlmRequest, joinUrl, LLM_PROXY_MOUNT, llmProxySubpath, type UpstreamCredential } from "../src/app/llm-proxy.ts";
import { resolvePiUpstream } from "../src/app/pi-credential-resolver.ts";
import { PROVIDER_KEY_ENV_VARS, stripProviderKeys } from "../src/app/provider-key-env.ts";
import { rewriteProviderUrl } from "../src/runtime/llm-proxy-fetch.ts";

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

test("llmProxySubpath: recovers the api-relative suffix (+ query), no /v1 doubling", () => {
  // The harness's redirect base URL is the mount itself; Pi appends `/chat/completions`.
  assert.equal(llmProxySubpath(`${LLM_PROXY_MOUNT}/chat/completions`), "chat/completions");
  assert.equal(llmProxySubpath(`${LLM_PROXY_MOUNT}/chat/completions`, "?beta=1"), "chat/completions?beta=1");
  assert.equal(llmProxySubpath(LLM_PROXY_MOUNT), ""); // bare mount -> empty suffix
  // The recovered suffix re-joins onto the REAL provider base URL exactly once.
  assert.equal(joinUrl("https://api.deepseek.com/v1", llmProxySubpath(`${LLM_PROXY_MOUNT}/chat/completions`)), "https://api.deepseek.com/v1/chat/completions");
});

test("rewriteProviderUrl: redirects only the provider origin, and the round-trip is an identity", () => {
  const table = new Map([["https://api.deepseek.com", "http://127.0.0.1:9/api/harness/llm"]]);
  // The real provider call is re-pointed at the proxy mount, suffix preserved.
  assert.equal(
    rewriteProviderUrl("https://api.deepseek.com/chat/completions", table),
    "http://127.0.0.1:9/api/harness/llm/chat/completions",
  );
  // Non-provider traffic (e.g. the gaia bridge) is left alone.
  assert.equal(rewriteProviderUrl("http://127.0.0.1:9/api/harness/memory", table), undefined);
  assert.equal(rewriteProviderUrl("https://example.com/x", table), undefined);
  // A different origin that merely shares a prefix substring must NOT match.
  assert.equal(rewriteProviderUrl("https://api.deepseek.com.evil.test/x", table), undefined);
  // Round-trip identity: redirect to the mount, recover the suffix, re-join the real base.
  const redirected = rewriteProviderUrl("https://api.deepseek.com/v1/chat/completions", table)!;
  const suffix = llmProxySubpath(new URL(redirected).pathname);
  assert.equal(joinUrl("https://api.deepseek.com", suffix), "https://api.deepseek.com/v1/chat/completions");
});

test("stripProviderKeys: deletes known LLM provider keys, leaves everything else", () => {
  const env: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: "sk-real",
    OPENAI_API_KEY: "sk-real-2",
    ANTHROPIC_API_KEY: "sk-real-3",
    PATH: "/usr/bin",
    GITHUB_TOKEN: "ghp-keepme", // git token deliberately preserved
  };
  stripProviderKeys(env);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin"); // untouched
  assert.equal(env.GITHUB_TOKEN, "ghp-keepme"); // not an LLM-proxy key
  // The map covers the common providers a summon would use.
  for (const v of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) assert.ok(PROVIDER_KEY_ENV_VARS.includes(v));
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
