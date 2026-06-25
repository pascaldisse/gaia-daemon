// Host-side LLM credential proxy. The daemon runs UNSANDBOXED, so it can read the
// real provider credentials; a confined turn cannot. The proxy closes the gap the
// sandbox can't: the turn's own provider key. A redirected harness talks to a
// loopback endpoint on the daemon carrying only its per-turn token; the daemon
// resolves the real upstream + key and injects it on the wire, then streams the
// response back. The raw key never enters the sandbox, and the real credential
// store is deny-read there, so a dumb summon cannot exfiltrate it.
//
// This module is deliberately SDK-free and transport-only (resolve happens in the
// caller), so it unit-tests without any harness, key, or network.

import type { IncomingMessage, ServerResponse } from "node:http";

export interface UpstreamCredential {
  /** Real provider base URL, e.g. `https://api.deepseek.com/v1` (trailing slash trimmed). */
  baseUrl: string;
  /** Auth headers carrying the REAL key, injected host-side, e.g. `{ authorization: "Bearer sk-…" }`. */
  authHeaders: Record<string, string>;
}

/** Resolve the real upstream + key for a proxied turn. Returns undefined when the
 *  agent has no proxyable credential (e.g. an OAuth harness), in which case the
 *  proxy refuses rather than leaking. Implemented by the daemon (it may read the
 *  real cred store / env); kept out of this module so the transport stays pure. */
export type LlmCredentialResolver = (claims: ProxyClaims, provider: string | undefined) => Promise<UpstreamCredential | undefined>;

export interface ProxyClaims {
  workspaceId: string;
  agentId: string;
  roomId: string;
}

// Hop-by-hop headers are connection-scoped and must not be forwarded; Node also
// recomputes length/encoding, so we let it own those.
const STRIP_REQUEST_HEADERS = new Set(["host", "authorization", "connection", "content-length", "transfer-encoding", "proxy-authorization"]);
const STRIP_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "content-length", "content-encoding", "keep-alive"]);

/** Join a base URL and a subpath without doubling or dropping slashes. */
export function joinUrl(baseUrl: string, subpath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const tail = subpath.replace(/^\/+/, "");
  return tail ? `${base}/${tail}` : base;
}

function buildRequestHeaders(incoming: IncomingMessage["headers"], auth: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The injected auth wins over anything the turn sent (it sent only a placeholder).
  for (const [key, value] of Object.entries(auth)) headers[key] = value;
  return headers;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function fail(response: ServerResponse, status: number, message: string): void {
  if (!response.headersSent) response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

/**
 * Forward an authenticated, resolved LLM request to the real upstream and stream
 * the response back verbatim. The caller MUST have verified the per-turn token and
 * resolved `upstream` already — this function injects the real key and never reads
 * the token. Streaming is preserved (SSE chat completions flow through chunk by
 * chunk). Fail-closed: on any upstream error the turn gets a 502, never the key.
 */
export async function forwardLlmRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: UpstreamCredential,
  subpath: string,
): Promise<void> {
  const method = request.method ?? "POST";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  const target = joinUrl(upstream.baseUrl, subpath);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target, {
      method,
      headers: buildRequestHeaders(request.headers, upstream.authHeaders),
      body,
    });
  } catch (error) {
    fail(response, 502, `llm proxy: upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const outHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders[key] = value;
  });
  response.writeHead(upstreamResponse.status, outHeaders);

  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  try {
    // Web ReadableStream is async-iterable on Node 18+; stream chunks straight
    // through so token-by-token SSE reaches the harness with no buffering.
    for await (const chunk of upstreamResponse.body as unknown as AsyncIterable<Uint8Array>) {
      response.write(chunk);
    }
  } catch {
    // Upstream cut the stream mid-flight; close what we have rather than hang.
  }
  response.end();
}
