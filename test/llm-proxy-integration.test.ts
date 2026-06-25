// End-to-end-ish integration of the credential proxy egress path, fully offline.
// It wires the REAL pieces the way a proxied Pi turn does — the actual `openai`
// SDK client Pi constructs, the real global-fetch redirect, the real transport
// (forwardLlmRequest), the real host-side resolver (resolveUpstreamCredential) — against a
// fake upstream. It proves the whole chain without a real provider, key, or daemon:
//
//   client (token) --redirect--> proxy --resolve+inject--> upstream (real key)
//
// The properties under test: the SDK request reaches the proxy (not the provider),
// carrying ONLY the per-turn token; the daemon swaps in the real key; and the
// streamed completion flows back so Pi would surface it.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import OpenAI from "openai";
import { forwardLlmRequest } from "../src/app/llm-proxy.ts";
import { resolveUpstreamCredential } from "../src/app/upstream-resolver.ts";
import { redirectProviderFetch } from "../src/runtime/llm-proxy-fetch.ts";

const REAL_KEY = "sk-REAL-UPSTREAM-KEY";
const TURN_TOKEN = "per-turn-token-abc";
const REAL_PROVIDER_BASE = "https://api.deepseek.com"; // never actually contacted

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("credential proxy egress: SDK→redirect→proxy→inject→upstream, token in, real key out, stream back", async () => {
  let upstreamAuth: string | undefined;
  let upstreamPath: string | undefined;
  // Fake upstream stands in for api.deepseek.com — emits an OpenAI streaming SSE.
  const upstream = await listen(async (req, res) => {
    upstreamAuth = req.headers.authorization;
    upstreamPath = req.url;
    await collect(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "deepseek-v4-pro", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    res.write(chunk("Hello"));
    res.write(chunk(" world"));
    res.write("data: [DONE]\n\n");
    res.end();
  });

  // The daemon-side resolver, fed injected deps so it resolves the fake upstream +
  // the real key (no real pi auth store touched).
  const resolverDeps = {
    registry: { find: () => ({ baseUrl: upstream.url }) },
    authStorage: { getApiKey: async () => REAL_KEY },
  };

  let proxyAuthSeen: string | undefined;
  // The proxy mount: verifies the per-turn token, resolves the upstream, injects
  // the real key (this IS handleLlmProxy's body, minus the HMAC verify).
  const proxy = await listen(async (req, res) => {
    proxyAuthSeen = req.headers.authorization;
    const upstreamCred = await resolveUpstreamCredential({ id: "a", model: { provider: "deepseek", name: "deepseek-v4-pro" } } as never, resolverDeps);
    if (!upstreamCred) {
      res.writeHead(502).end("no upstream");
      return;
    }
    const subpath = (req.url ?? "/").replace(/^\/api\/harness\/llm\/?/, "");
    await forwardLlmRequest(req, res, upstreamCred, subpath);
  });
  const proxyMount = `${proxy.url}/api/harness/llm`;

  // Client side: exactly what PiRuntime.applyCredentialProxy does — present the
  // token as the key (Pi's registerProvider authHeader path) and redirect the
  // provider origin to the proxy mount at the fetch layer (baseUrl left REAL).
  redirectProviderFetch(REAL_PROVIDER_BASE, proxyMount);
  const client = new OpenAI({ apiKey: TURN_TOKEN, baseURL: REAL_PROVIDER_BASE });

  const stream = await client.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  let text = "";
  for await (const part of stream) text += part.choices[0]?.delta?.content ?? "";

  // The SDK request was redirected to the proxy (real provider never contacted)...
  assert.equal(proxyAuthSeen, `Bearer ${TURN_TOKEN}`); // ...carrying ONLY the token
  // ...the daemon swapped the token for the real key before the upstream...
  assert.equal(upstreamAuth, `Bearer ${REAL_KEY}`);
  assert.notEqual(upstreamAuth, `Bearer ${TURN_TOKEN}`); // the token never reached upstream
  assert.equal(upstreamPath, "/chat/completions"); // suffix preserved + re-joined onto the real base
  assert.equal(text, "Hello world"); // the streamed completion flowed all the way back

  upstream.server.close();
  proxy.server.close();
});
