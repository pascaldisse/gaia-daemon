import { createHash } from "node:crypto";
import { IMAGE_MAX_BASE64_BYTES, normalizeImage } from "./image.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Wire image guard → attachments + retained history + native tool images.
 * Content containers only; never rewrite tool arguments, schemas, or text. */
export function createImageRequestNormalizer(options: { maxBase64Bytes?: number; cacheEntries?: number } = {}) {
  const cap = options.maxBase64Bytes ?? IMAGE_MAX_BASE64_BYTES;
  const cacheEntries = options.cacheEntries ?? 8;
  const cache = new Map<string, { data: string; mimeType: string }>();
  async function image(data: string, mimeType: string) {
    if (data.length <= cap) return undefined;
    const key = createHash("sha256").update(mimeType).update(data).digest("hex");
    let result = cache.get(key);
    if (result) cache.delete(key);
    else result = await normalizeImage(Buffer.from(data, "base64"), mimeType, cap);
    if (cacheEntries > 0) {
      cache.set(key, result);
      while (cache.size > cacheEntries) cache.delete(cache.keys().next().value!);
    }
    return result;
  }
  async function dataUrl(value: unknown): Promise<string | undefined> {
    if (typeof value !== "string" || value.length <= cap || !value.startsWith("data:image/")) return undefined;
    const comma = value.indexOf(",");
    if (comma < 0 || !value.slice(0, comma).endsWith(";base64")) return undefined;
    const result = await image(value.slice(comma + 1), value.slice(5, comma - 7));
    return result ? `data:${result.mimeType};base64,${result.data}` : undefined;
  }
  return async function normalizeImageRequest(bodyText: string): Promise<string | undefined> {
    if (bodyText.length <= cap) return undefined;
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { return undefined; }
    if (!record(body)) return undefined;
    let changed = false;
    async function content(value: unknown): Promise<void> {
      if (Array.isArray(value)) { for (const block of value) await content(block); return; }
      if (!record(value)) return;
      const source = value.source;
      if (value.type === "image" && record(source) && source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string" && source.media_type.startsWith("image/")) {
        const result = await image(source.data, source.media_type);
        if (result) { source.data = result.data; source.media_type = result.mimeType; changed = true; }
      }
      if (value.type === "image_url" || value.type === "input_image") {
        const holder = record(value.image_url) ? value.image_url : value;
        const key = holder === value ? "image_url" : "url";
        const result = await dataUrl(holder[key]);
        if (result) { holder[key] = result; changed = true; }
      }
      // Gemini REST + SDK spellings.
      for (const key of ["inlineData", "inline_data"]) {
        const inline = value[key];
        const mimeKey = key === "inlineData" ? "mimeType" : "mime_type";
        if (!record(inline) || typeof inline.data !== "string" || typeof inline[mimeKey] !== "string" || !inline[mimeKey].startsWith("image/")) continue;
        const result = await image(inline.data, inline[mimeKey]);
        if (result) { inline.data = result.data; inline[mimeKey] = result.mimeType; changed = true; }
      }
      if (value.type === "tool_result") await content(value.content);
    }
    for (const key of ["messages", "input", "contents"]) {
      const messages = body[key];
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (!record(message)) continue;
        await content(message.content ?? message.parts);
      }
    }
    return changed ? JSON.stringify(body) : undefined;
  };
}

export const normalizeImageRequest = createImageRequestNormalizer();
type FetchFn = typeof globalThis.fetch;

/** Uniform runner transport seam; proxy uses the same body normalizer. */
export function wrapImageRequestFetch(next: FetchFn, normalize = normalizeImageRequest): FetchFn {
  const wrapped = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const request = input instanceof Request ? input : undefined;
    const body = init?.body;
    let text: string | undefined;
    if (typeof body === "string") text = body;
    else if (body instanceof Uint8Array) text = Buffer.from(body).toString("utf8");
    else if (body instanceof ArrayBuffer) text = Buffer.from(body).toString("utf8");
    else if (request && body === undefined && request.body && !request.bodyUsed) {
      const contentType = new Headers(init?.headers ?? request.headers).get("content-type");
      if (contentType?.includes("json")) text = await request.clone().text();
    }
    const rewritten = text === undefined ? undefined : await normalize(text);
    if (rewritten === undefined) return next(input, init);
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete("content-length");
    return next(input, { ...init, headers, body: rewritten });
  };
  return Object.assign(wrapped, next) as FetchFn;
}
