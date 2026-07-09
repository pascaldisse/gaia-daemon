// Loopback egress shim for the Claude Code harness — reveals extended-thinking text.
//
// WHY THIS EXISTS: newer Claude models hard-default the Messages API's
// `thinking.display` to "omitted", so the reasoning *text* is redacted (only an
// encrypted signature streams back). Claude Code exposes NO flag/env/setting to
// change that. The one lever is the request body itself, which we can only reach
// by sitting in front of the CLI's egress. This proxy injects
// `thinking.display: "summarized"` into /v1/messages requests; the API then
// streams `thinking_delta` text, Claude Code forwards it, and gaia's existing
// stream-json parser renders it as normal thinking output.
//
// SCOPE: body-only mutation. Auth headers (subscription OAuth Bearer, x-api-key,
// or the credential proxy's per-turn token) pass through UNTOUCHED — this never
// sees or swaps a credential. It forwards to whatever ANTHROPIC_BASE_URL would
// otherwise have been (the credential proxy when on, else Anthropic direct), so
// it composes with that path instead of bypassing it.
//
// FAIL-OPEN: every failure mode (unparseable body, upstream error, wrong path)
// forwards bytes unchanged. A broken proxy must degrade to "no thinking text",
// never to a broken turn. Unconditional: every claude agent runs behind this so
// reasoning text is always visible (pi/codex already stream it natively) — no
// opt-in, matching gaia's "reveal thinking is always on" posture.

import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";

export interface ThinkingProxyHandle {
  /** Base URL to hand Claude Code as ANTHROPIC_BASE_URL. */
  url: string;
  /** Best-effort shutdown (idempotent). */
  close(): void;
}

// Only the Messages endpoint carries a thinking config worth touching.
function isMessagesPath(path: string): boolean {
  return path.split("?", 1)[0].endsWith("/v1/messages");
}

// Add display:"summarized" to an already-enabled thinking config. We deliberately
// do NOT synthesize a thinking block where none exists or where it's disabled:
//  - `{type:"disabled", display:...}` is a 400 ("Extra inputs are not permitted"),
//  - forcing thinking onto a turn that opted out would change behavior.
// So this reveals reasoning the model was already going to do — nothing more.
function injectDisplay(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // not JSON — pass through untouched
  }
  if (!parsed || typeof parsed !== "object") return body;
  const thinking = (parsed as { thinking?: unknown }).thinking;
  if (!thinking || typeof thinking !== "object") return body;
  const t = thinking as { type?: unknown; display?: unknown };
  if (t.type === "disabled") return body; // API rejects display on a disabled block
  if (t.display === "summarized") return body; // already asking for it
  t.display = "summarized";
  return JSON.stringify(parsed);
}

// Join the upstream base path with the request path so we compose with a
// path-bearing upstream (e.g. the credential proxy mount /api/harness/llm).
function joinPath(basePath: string, reqPath: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  return `${trimmed}${reqPath}`;
}

/**
 * Start a loopback proxy in front of `upstream` that injects
 * thinking.display:"summarized" into Messages requests. Resolves once it is
 * listening. `upstream` is the base URL Claude Code would otherwise call
 * (default https://api.anthropic.com).
 */
export function startThinkingProxy(upstream: string): Promise<ThinkingProxyHandle> {
  const target = new URL(upstream);
  const forward = target.protocol === "http:" ? http : https;
  const upstreamPort = target.port ? Number(target.port) : target.protocol === "http:" ? 80 : 443;

  const server = http.createServer((cReq, cRes) => {
    const chunks: Buffer[] = [];
    cReq.on("data", (c) => chunks.push(c as Buffer));
    cReq.on("error", () => cRes.writeHead(502).end());
    cReq.on("end", () => {
      const reqPath = cReq.url ?? "/";
      let outBody = Buffer.concat(chunks);
      if (isMessagesPath(reqPath) && outBody.length > 0) {
        const mutated = injectDisplay(outBody.toString("utf8"));
        outBody = Buffer.from(mutated, "utf8");
      }

      // Forward every header verbatim (auth included) except host/content-length,
      // which must describe THIS hop.
      const headers: IncomingHttpHeaders = { ...cReq.headers };
      headers.host = target.host;
      headers["content-length"] = String(outBody.length);

      const uReq = forward.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: upstreamPort,
          method: cReq.method,
          path: joinPath(target.pathname, reqPath),
          headers,
        },
        (uRes) => {
          // Pipe the response straight back — we never parse it; Claude Code does.
          cRes.writeHead(uRes.statusCode ?? 502, uRes.headers);
          uRes.pipe(cRes);
        },
      );
      uReq.on("error", () => {
        if (!cRes.headersSent) cRes.writeHead(502);
        cRes.end();
      });
      uReq.end(outBody);
    });
  });

  return new Promise<ThinkingProxyHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("thinking proxy failed to bind a loopback port"));
        return;
      }
      let closed = false;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close() {
          if (closed) return;
          closed = true;
          server.close();
        },
      });
    });
  });
}
