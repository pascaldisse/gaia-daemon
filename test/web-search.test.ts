import { test } from "bun:test";
import assert from "node:assert/strict";
import { searchWeb } from "../src/services/web-search.js";

test("web search falls back from Brave 429 to Tavily and normalizes the result", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api.search.brave.com/")) return new Response("quota exhausted", { status: 429 });
    if (url === "https://api.tavily.com/search") {
      return Response.json({ results: [{ title: "Tavily result", url: "https://example.com/tavily", content: "Tavily snippet" }] });
    }
    throw new Error(`unexpected provider: ${url}`);
  };
  const logs: string[] = [];

  const response = await searchWeb(
    { query: "fallback chain", maxResults: 3 },
    { fetch: fetcher, env: { BRAVE_API_KEY: "brave-test-key", TAVILY_API_KEY: "tavily-test-key", SERPER_API_KEY: "serper-test-key" }, secretsPath: "/does-not-exist", log: (message) => logs.push(message) },
  );

  assert.equal(response.provider, "tavily");
  assert.deepEqual(response.results, [{ title: "Tavily result", url: "https://example.com/tavily", snippet: "Tavily snippet" }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? "", /q=fallback\+chain/);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-subscription-token"), "brave-test-key");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.equal(new Headers(calls[1]?.init?.headers).get("authorization"), "Bearer tavily-test-key");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { query: "fallback chain", max_results: 3 });
  assert.deepEqual(logs, ["[gaia:web] brave unavailable: HTTP 429 from brave; trying next provider", "[gaia:web] served by tavily"]);
});

test("an explicit provider does not fall through", async () => {
  let calls = 0;
  await assert.rejects(
    searchWeb(
      { query: "forced", provider: "brave" },
      { fetch: async () => { calls++; return new Response("denied", { status: 403 }); }, env: { BRAVE_API_KEY: "brave-test-key", TAVILY_API_KEY: "tavily-test-key" }, secretsPath: "/does-not-exist", log: () => {} },
    ),
    /brave \(HTTP 403 from brave\)/,
  );
  assert.equal(calls, 1);
});
