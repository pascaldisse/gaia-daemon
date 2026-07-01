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

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(request: IncomingMessage): string | undefined {
  const auth = request.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
}
