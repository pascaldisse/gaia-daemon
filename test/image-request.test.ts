import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { loadNativeImages } from "../src/core/attachments.js";
import { IMAGE_MAX_BASE64_BYTES, normalizeImage } from "../src/core/image.js";
import { createImageRequestNormalizer, wrapImageRequestFetch } from "../src/core/image-request.js";

function png(edge: number): Buffer {
  const pixels = randomFillSync(new Uint8Array(edge * edge * 4));
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const image = new PhotonImage(pixels, edge, edge);
  try { return Buffer.from(image.get_bytes()); } finally { image.free(); }
}
const small = png(64);
const cap = 4096;
const source = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: small.toString("base64") } });
const requestBody = () => ({ model: "test", messages: [{ role: "user", content: [{ type: "text", text: "look" }, source()] }] });

function assertImage(data: string, mime: string, limit: number): void {
  assert.ok(data.length <= limit, `${data.length} > ${limit}`);
  const bytes = Buffer.from(data, "base64");
  assert.ok(bytes.length <= limit * 3 / 4);
  if (mime === "image/jpeg") assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff");
  else assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const decoded = PhotonImage.new_from_byteslice(bytes);
  try { assert.ok(decoded.get_width() > 0 && decoded.get_height() > 0); } finally { decoded.free(); }
}

test("attachment > provider 10MiB base64 → bounded decodable copy; original unchanged", async () => {
  const bytes = png(1800);
  assert.ok(bytes.toString("base64").length > 10 * 1024 * 1024);
  const dir = await mkdtemp(join(tmpdir(), "image-cap-"));
  try {
    const path = join(dir, "original.png");
    await writeFile(path, bytes);
    const file = { id: "image", name: "original.png", mime: "image/png", size: bytes.length, path };
    const result = await loadNativeImages([file]);
    assert.equal(result.length, 1);
    assertImage(result[0].base64, result[0].attachment.mime, IMAGE_MAX_BASE64_BYTES);
    assert.equal(result[0].attachment.path, path);
    assert.equal(file.mime, "image/png");
    assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("quality fallback eventually resizes while honoring an explicit tight cap", async () => {
  const result = await normalizeImage(png(128), "image/png", 1024);
  assertImage(result.data, result.mimeType, 1024);
  const decoded = PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
  try { assert.ok(decoded.get_width() < 128); } finally { decoded.free(); }
});

test("small images retain bytes/MIME; unreadable attachments remain breadcrumb-only", async () => {
  assert.deepEqual(await normalizeImage(small, "image/png"), { data: small.toString("base64"), mimeType: "image/png" });
  assert.deepEqual(await loadNativeImages([{ id: "missing", name: "missing.png", mime: "image/png", size: 1, path: join(tmpdir(), "missing-image", "file.png") }]), []);
  await assert.rejects(normalizeImage(small, "image/png", 0), /invalid image byte cap/);
});

test("history + nested tool results protected; cache repeat idempotent; tool args untouched", async () => {
  const normalize = createImageRequestNormalizer({ maxBase64Bytes: cap, cacheEntries: 1 });
  const body = requestBody();
  body.messages.unshift({ role: "user", content: [{ type: "tool_result", content: [source()] } as any, { type: "tool_use", input: source() } as any] });
  const raw = JSON.stringify(body);
  const result = await normalize(raw);
  assert.ok(result);
  assert.equal(await normalize(raw), result);
  assert.equal(await normalize(result), undefined);
  const parsed = JSON.parse(result);
  assertImage(parsed.messages[0].content[0].content[0].source.data, parsed.messages[0].content[0].content[0].source.media_type, cap);
  assert.deepEqual(parsed.messages[0].content[1].input, source());
  assert.deepEqual(parsed.messages[1].content[0], { type: "text", text: "look" });
  assertImage(parsed.messages[1].content[1].source.data, parsed.messages[1].content[1].source.media_type, cap);
});

test("Chat/Responses/Gemini inline wire formats share guard; remote URLs untouched", async () => {
  const normalize = createImageRequestNormalizer({ maxBase64Bytes: cap });
  const url = `data:image/png;base64,${small.toString("base64")}`;
  const body = {
    messages: [{ content: [{ type: "image_url", image_url: { url, detail: "high" } }, { type: "image_url", image_url: { url: "https://example.com/image.png" } }] }],
    input: [{ role: "user", content: [{ type: "input_image", image_url: url }] }],
    contents: [{ parts: [{ inlineData: { data: small.toString("base64"), mimeType: "image/png" } }, { inline_data: { data: small.toString("base64"), mime_type: "image/png" } }] }],
  };
  const result = JSON.parse((await normalize(JSON.stringify(body)))!);
  for (const value of [result.messages[0].content[0].image_url.url, result.input[0].content[0].image_url]) {
    const [header, data] = value.split(",");
    assertImage(data, header.slice(5, -7), cap);
  }
  assert.equal(result.messages[0].content[0].image_url.detail, "high");
  assert.deepEqual(result.messages[0].content[1], body.messages[0].content[1]);
  for (const value of result.contents[0].parts) {
    const inline = value.inlineData ?? value.inline_data;
    assertImage(inline.data, inline.mimeType ?? inline.mime_type, cap);
  }
});

test("unrelated payloads / invalid JSON / small requests pass byte-for-byte", async () => {
  const normalize = createImageRequestNormalizer({ maxBase64Bytes: cap });
  assert.equal(await normalize("not json".repeat(cap)), undefined);
  assert.equal(await normalize(JSON.stringify({ arguments: source() })), undefined);
  assert.equal(await normalize(JSON.stringify({ messages: [{ content: [{ type: "text", text: small.toString("base64") }] }] })), undefined);
  assert.equal(await normalize("{}"), undefined);
});

test("fetch string/bytes/Request bodies preserve headers + signal and remove stale length", async () => {
  const normalizer = createImageRequestNormalizer({ maxBase64Bytes: cap });
  const raw = JSON.stringify(requestBody());
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const next = (async (input: unknown, init?: RequestInit) => { calls.push({ input, init }); return new Response("ok"); }) as typeof fetch;
  const taggedNext = Object.assign(next, { preconnect: () => "preserved" });
  const wrapped = wrapImageRequestFetch(taggedNext, normalizer);
  assert.equal(wrapped.preconnect, taggedNext.preconnect);
  const signal = new AbortController().signal;
  for (const body of [raw, Buffer.from(raw), new TextEncoder().encode(raw).buffer]) {
    await wrapped("https://provider.test/messages", { method: "POST", body, signal, headers: { "content-type": "application/json", "content-length": String(raw.length), authorization: "test-token" } });
  }
  const request = new Request("https://provider.test/messages", { method: "POST", body: raw, headers: { "content-type": "application/json", authorization: "test-token", "content-length": String(raw.length) } });
  await wrapped(request);
  assert.equal(request.bodyUsed, false);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("content-length"), null);
    assert.equal(headers.get("authorization"), "test-token");
    const body = JSON.parse(String(call.init?.body));
    assertImage(body.messages[0].content[1].source.data, body.messages[0].content[1].source.media_type, cap);
  }
  assert.equal(calls[0].init?.signal, signal);
  const init = { method: "POST", body: "{}" };
  await wrapped("https://provider.test/messages", init);
  assert.equal(calls.at(-1)?.init, init);
});
