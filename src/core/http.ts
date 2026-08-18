// Shared node:http request/response helpers, so every server surface (the web
// server, the OpenAI-compatible monad serve adapter, the voice bridge) reads
// bodies, writes JSON/text, and extracts the bearer token the same way. Only
// genuinely-identical logic lives here; surface-specific shaping stays local.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Largest request body we buffer before rejecting (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Write `value` as a JSON response with the given status. */
export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** Write `body` as a plain-text response with the given status. */
export function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

/**
 * Buffer and JSON-parse a request body. An empty body resolves to `{}`; a body
 * over the 1 MiB cap rejects (and destroys the request); malformed JSON rejects.
 */
export function parseBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/**
 * Buffer a raw (binary) request body up to `maxBytes` (rejects and destroys
 * the request past it). Backs the attachment upload route — pasted files are
 * sent as the bare body, not JSON.
 */
export function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`File too large (over ${Math.round(maxBytes / (1024 * 1024))} MiB)`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(request: IncomingMessage): string | undefined {
  const auth = request.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
}

/** One named cookie's value from the raw `Cookie` header, or undefined. */
export function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** `Set-Cookie` value: HttpOnly + SameSite=Lax always; `maxAgeSeconds` undefined
 * clears it (session-scoped cookie, browser drops on close) — pass 0 to delete. */
export function cookieHeader(name: string, value: string, maxAgeSeconds?: number): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}
