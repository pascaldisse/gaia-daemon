// A minimal OpenAI-compatible serve adapter: POST /v1/chat/completions runs the
// room's monad over the request's messages and returns the single final answer
// as one assistant message; GET /v1/models lists the one virtual model. This is
// the "answer as one" surface — clients (and Fugu's own eval harness) talk to a
// monad room as if it were a single model. Non-streaming for simplicity; the seam
// (serve-registry) allows a richer adapter as a plugin.

import { createServer } from "node:http";
import { json, parseBody } from "../../../lib/http.js";
import { registerServeAdapter, type ServeHandle, type ServeStartOptions } from "../serve-registry.js";
import type { ChatMessage } from "../types.js";

function messagesFrom(body: unknown): ChatMessage[] {
  const raw = body && typeof body === "object" ? (body as { messages?: unknown }).messages : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is { role?: unknown; content?: unknown } => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({ role: typeof entry.role === "string" ? entry.role : "user", content: typeof entry.content === "string" ? entry.content : "" }));
}

function completionPayload(id: string, content: string): unknown {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: "gaia-monad",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

registerServeAdapter({
  id: "openai-compatible",
  ui: { label: "OpenAI-compatible", description: "POST /v1/chat/completions → one monad answer. GET /v1/models lists 'gaia-monad'." },
  async start(options: ServeStartOptions): Promise<ServeHandle> {
    let counter = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://gaia.local");
        if (request.method === "GET" && url.pathname === "/v1/models") {
          json(response, 200, { object: "list", data: [{ id: "gaia-monad", object: "model", created: 0, owned_by: "gaia" }] });
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
          const messages = messagesFrom(await parseBody(request));
          if (messages.length === 0) {
            json(response, 400, { error: { message: "Request contains no messages", type: "invalid_request_error" } });
            return;
          }
          const answer = await options.run(messages);
          json(response, 200, completionPayload(`chatcmpl-${++counter}`, answer));
          return;
        }
        json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      })().catch((error) => {
        if (!response.headersSent) json(response, 500, { error: { message: error instanceof Error ? error.message : String(error), type: "server_error" } });
        else response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : options.port;
    return {
      url: `http://${options.host}:${boundPort}/v1`,
      stop: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
  },
});
