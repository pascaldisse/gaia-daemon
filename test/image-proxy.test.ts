import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomFillSync } from "node:crypto";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { forwardLlmRequest } from "../src/services/proxy.js";
import { IMAGE_MAX_BASE64_BYTES } from "../src/core/image.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("credential proxy normalizes retained inline images before upstream; preserves SSE + auth", async () => {
  const pixels = randomFillSync(new Uint8Array(1200 * 1200 * 4));
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const image = new PhotonImage(pixels, 1200, 1200);
  let data: string;
  try { data = Buffer.from(image.get_bytes()).toString("base64"); } finally { image.free(); }
  assert.ok(data.length > IMAGE_MAX_BASE64_BYTES);
  let seen: any;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen = { body: JSON.parse(Buffer.concat(chunks).toString()), auth: request.headers.authorization, url: request.url };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: image-accepted\n\n");
    response.end("data: [DONE]\n\n");
  });
  const url = await listen(upstream);
  const proxy = createServer((request, response) => {
    void forwardLlmRequest(request, response, { baseUrl: url, authHeaders: { authorization: "Bearer resolved-key" } }, "messages");
  });
  const proxyUrl = await listen(proxy);
  try {
    const response = await fetch(proxyUrl, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer placeholder" }, body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data, media_type: "image/png" } }] }] }) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: image-accepted\n\ndata: [DONE]\n\n");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(seen.auth, "Bearer resolved-key");
    assert.equal(seen.url, "/messages");
    const source = seen.body.messages[0].content[0].source;
    assert.ok(source.data.length <= IMAGE_MAX_BASE64_BYTES);
    assert.equal(source.media_type, "image/jpeg");
    const decoded = PhotonImage.new_from_byteslice(Buffer.from(source.data, "base64"));
    try { assert.equal(decoded.get_width(), 1200); } finally { decoded.free(); }
  } finally { await close(proxy); await close(upstream); }
});
