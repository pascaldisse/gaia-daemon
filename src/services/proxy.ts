// Host-side LLM credential proxy + upstream resolution. The daemon runs
// UNSANDBOXED, so it can read the real provider credentials; a confined turn
// cannot. A redirected harness talks to a loopback endpoint carrying only its
// per-turn token; the daemon resolves the real upstream + key, injects it on
// the wire, and streams the response back. The raw key never enters the
// sandbox, and the real cred store is deny-read there.
//
// Resolution is keyed by the model's PROVIDER, never by harness (AGENTS.md
// §RULE #0). Fail-closed: no resolvable key → the turn is refused, never
// forwarded unauthenticated.

import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../core/types.js";

export interface UpstreamCredential {
  /** Real provider base URL (trailing slash trimmed). */
  baseUrl: string;
  /** Auth headers carrying the REAL key, injected host-side. */
  authHeaders: Record<string, string>;
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

// The mount constant lives on the wire contract (harness/protocol.ts); this
// re-export keeps the proxy module the one import for proxy-shaped concerns.
export { LLM_PROXY_MOUNT } from "../harness/protocol.js";
import { LLM_PROXY_MOUNT } from "../harness/protocol.js";

/** `/api/harness/llm/chat/completions?x=1` → `chat/completions?x=1`. */
export function llmProxySubpath(pathname: string, search = ""): string {
  const tail = pathname.startsWith(LLM_PROXY_MOUNT) ? pathname.slice(LLM_PROXY_MOUNT.length) : pathname;
  return tail.replace(/^\/+/, "") + search;
}

function buildRequestHeaders(incoming: IncomingMessage["headers"], auth: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The injected auth wins over anything the turn sent (a placeholder).
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
 * Forward an authenticated, resolved LLM request to the real upstream and
 * stream the response back verbatim. The caller MUST have verified the token
 * and resolved `upstream` — this function injects the real key and never reads
 * the token. SSE streaming is preserved chunk by chunk.
 */
export async function forwardLlmRequest(request: IncomingMessage, response: ServerResponse, upstream: UpstreamCredential, subpath: string): Promise<void> {
  const method = request.method ?? "POST";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  const target = joinUrl(upstream.baseUrl, subpath);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target, {
      method,
      headers: buildRequestHeaders(request.headers, upstream.authHeaders),
      // Buffer satisfies fetch's body at runtime; the undici typing only admits
      // Uint8Array views, which a Buffer is.
      body: body ? new Uint8Array(body) : undefined,
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

// --- upstream resolution --------------------------------------------------------

/** Minimal shapes, so tests inject fakes without standing up the SDK. */
export interface UpstreamResolverDeps {
  authStorage?: { getApiKey(providerId: string): Promise<string | undefined> };
  registry?: { find(provider: string, modelId: string): { baseUrl?: string } | undefined };
}

/** Auth headers by provider wire protocol (provider data, not a harness case). */
function authHeadersFor(provider: string, key: string): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": key };
  return { authorization: `Bearer ${key}` };
}

/** The real key for a provider from the Pi auth store (auth.json/OAuth/env). Daemon-side only. */
export async function lookupProviderKey(providerId: string, store: NonNullable<UpstreamResolverDeps["authStorage"]> = AuthStorage.create()): Promise<string | undefined> {
  return store.getApiKey(providerId);
}

export async function resolveUpstreamCredential(agent: AgentDef, deps: UpstreamResolverDeps = {}): Promise<UpstreamCredential | undefined> {
  const provider = agent.model?.provider;
  const name = agent.model?.name;
  if (!provider || !name) return undefined;

  const authStorage = deps.authStorage ?? AuthStorage.create();
  const registry = deps.registry ?? ModelRegistry.create(authStorage as AuthStorage);
  const model = registry.find(provider, name);
  if (!model?.baseUrl) return undefined; // unknown model → can't pick an upstream

  const key = await lookupProviderKey(provider, authStorage);
  if (!key) return undefined; // OAuth/subscription/unconfigured → refuse rather than leak

  return { baseUrl: model.baseUrl, authHeaders: authHeadersFor(provider, key) };
}
