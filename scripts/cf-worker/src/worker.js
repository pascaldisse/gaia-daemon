// GAIA remote front door: stable workers.dev hostname proxying to whatever
// cloudflared quick-tunnel hostname is currently live, as stored in KV.
//
// KV binding: GAIA_EDGE, key "origin" -> "https://<current>.trycloudflare.com"
//
// The origin value is cached in a module-level variable for 15s so we don't
// hit KV on every request (KV reads are billed and rate-limited).

let cachedOrigin = null;
let cachedAt = 0;
const CACHE_MS = 15000;

async function getOrigin(env) {
  const now = Date.now();
  if (cachedOrigin && now - cachedAt < CACHE_MS) {
    return cachedOrigin;
  }
  const origin = await env.GAIA_EDGE.get("origin");
  cachedOrigin = origin;
  cachedAt = now;
  return origin;
}

export default {
  async fetch(request, env, ctx) {
    const origin = await getOrigin(env);
    if (!origin) {
      return new Response("no origin configured", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }

    const inUrl = new URL(request.url);
    const originUrl = new URL(origin);
    const outUrl = new URL(inUrl.pathname + inUrl.search, originUrl.origin);

    // Rebuild the request against the new origin, preserving method, headers
    // (including Upgrade: websocket), and body. redirect: 'manual' so the
    // /auth 302 + Set-Cookie from edge-proxy passes through untouched instead
    // of being followed by the Workers runtime's fetch().
    const outReq = new Request(outUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    });

    // For WebSocket upgrade requests, the Workers runtime automatically
    // passes through the Upgrade/Connection handshake when we just return
    // the fetch() response verbatim (no buffering) — same code path as SSE
    // and normal HTTP, so no special-casing is needed here.
    return fetch(outReq);
  },
};
