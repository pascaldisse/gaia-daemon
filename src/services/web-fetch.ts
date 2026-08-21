/// <reference types="bun-types" />
// Bun-native readable-content extraction for gaia web fetch. Ported from the
// gaia-daemon.chat-ms7n5srk-ejm5 branch's bundled skills/brave-search/{extract,content}.js
// (commit 0527bd1, never merged to main) -- same Bun HTMLRewriter approach:
// zero npm deps (no jsdom/@mozilla/readability/turndown), heuristic not a full
// Readability port. Strips chrome (script/style/nav/header/footer/aside/forms/
// etc.), keeps headings/paragraphs/list items as light markdown.
//
// Suppression note (inherited from the original skill, verified there live):
// a "*" element handler's el.remove() does NOT stop a sibling text() handler
// on the same selector from still seeing text inside the removed element --
// HTMLRewriter dispatches per-selector independently of output mutation. Fixed
// via el.onEndTag() tracking a manual suppress-depth counter around drop-tag
// subtrees. Void elements never get an end tag -- calling el.onEndTag() on one
// throws "No end tag", and they can't contain text, so they need no counter.

import { gaiaWebFetchCommentsDefault, gaiaWebFetchCommentsMax, gaiaWebFetchMaxBytes, gaiaWebFetchTimeoutMs, gaiaWebFetchTranscriptDefault } from "../core/config.js";
import { findVideoTranscriptProvider, VIDEO_TRANSCRIPT_PROVIDERS, type VideoComment, type VideoTranscriptProvider } from "./video-transcript.js";

const DROP_TAGS = new Set([
  "script", "style", "noscript", "svg", "iframe", "nav", "header", "footer",
  "aside", "form", "button", "input", "select", "textarea", "template",
  "link", "meta", "noembed", "object", "embed", "canvas",
]);
const VOID_TAGS = new Set((["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]));
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "li", "tr", "blockquote", "pre", "br", "hr"]);

export interface ExtractedContent {
  title: string;
  text: string;
}

/** Readable-content extraction: strips nav/ads/scripts/styles, keeps
 * headings/paragraphs/list items as light markdown. Bun-native (HTMLRewriter),
 * no npm deps -- see BUN ONLY law in AGENTS.md. */
export async function extractReadable(html: string): Promise<ExtractedContent> {
  const parts: string[] = [];
  let title = "";
  let inTitle = 0;
  let suppress = 0;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === "title") {
        inTitle++;
        el.onEndTag(() => { inTitle--; });
        return;
      }
      if (DROP_TAGS.has(tag)) {
        if (!VOID_TAGS.has(tag)) {
          suppress++;
          el.onEndTag(() => { suppress--; });
        }
        return;
      }
      if (HEADING_TAGS.has(tag)) parts.push(`\n\n${"#".repeat(Number(tag[1]))} `);
      else if (tag === "li") parts.push("\n- ");
      else if (BLOCK_TAGS.has(tag)) parts.push("\n");
    },
    text(t) {
      if (inTitle > 0) {
        title += t.text;
        return;
      }
      if (suppress === 0 && t.text) parts.push(t.text);
    },
  });

  // transform() is lazy -- must drain the resulting stream to actually run
  // the parse + fire the handlers above.
  await rewriter.transform(new Response(html)).text();

  const text = parts
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title: title.trim(), text };
}

export interface WebFetchRequest {
  url: string;
  /** Truncate extracted text to this many bytes (UTF-8). Falls back to
   * gaiaWebFetchMaxBytes()/GAIA_WEB_FETCH_MAX_BYTES; no hardcoded cap. */
  maxBytes?: number;
  /** Attach a video transcript when the url matches a registered video
   * provider. Falls back to gaiaWebFetchTranscriptDefault()/GAIA_WEB_FETCH_TRANSCRIPT
   * (default true) when omitted. */
  transcript?: boolean;
  /** Caption/transcript language. Falls back to gaiaVideoTranscriptDefaultLang(). */
  lang?: string;
  /** Attach top-level video comments (token-heavy -- opt-in). `true` uses
   * gaiaWebFetchCommentsMax()/GAIA_WEB_FETCH_COMMENTS_MAX as the count; a
   * number is an explicit count. Falls back to gaiaWebFetchCommentsDefault()/
   * GAIA_WEB_FETCH_COMMENTS (default false) when omitted. */
  comments?: boolean | number;
}

export interface WebFetchVideo {
  provider: string;
  videoId: string;
  lang: string;
  channel?: string;
  description?: string;
  transcript: string;
  entries: number;
  truncated: boolean;
  comments?: VideoComment[];
  /** Present when comments were requested but couldn't be parsed (innertube
   * shape shift, disabled comments, etc.) -- soft-degrade, never a thrown error. */
  commentsUnavailable?: string;
}

export interface WebFetchResponse {
  url: string;
  title: string;
  text: string;
  bytes: number;
  truncated: boolean;
  video?: WebFetchVideo;
}

export interface WebFetchOptions {
  fetch?: typeof globalThis.fetch;
  /** Request timeout in ms. Falls back to gaiaWebFetchTimeoutMs()/GAIA_WEB_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  userAgent?: string;
  /** Override the registered video-transcript providers (tests / future providers). */
  videoProviders?: VideoTranscriptProvider[];
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  // Binary-search the largest prefix whose UTF-8 byte length fits maxBytes --
  // slicing by JS string length can split a multi-byte codepoint, but never
  // overshoots maxBytes since Buffer.byteLength is monotonic in prefix length.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), truncated: true };
}

/** Fetch a URL and extract clean, low-token readable content -- title + main
 * text, chrome stripped -- instead of raw HTML. The efficient alternative to
 * `curl`ing a page and feeding the model raw markup. */
export async function fetchWeb(request: WebFetchRequest, options: WebFetchOptions = {}): Promise<WebFetchResponse> {
  const url = request.url.trim();
  if (!url) throw new Error("web fetch requires a url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported url scheme: ${parsed.protocol}`);
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? gaiaWebFetchTimeoutMs();
  const maxBytes = request.maxBytes ?? gaiaWebFetchMaxBytes();

  const response = await fetcher(parsed, {
    headers: {
      "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${parsed.hostname}`);

  const html = await response.text();
  const { title: extractedTitle, text: extractedText } = await extractReadable(html);

  const videoMatch = findVideoTranscriptProvider(parsed, options.videoProviders ?? VIDEO_TRANSCRIPT_PROVIDERS);
  let title = extractedTitle;
  let text = extractedText;
  let video: WebFetchVideo | undefined;

  if (videoMatch && (request.transcript ?? gaiaWebFetchTranscriptDefault())) {
    const result = await videoMatch.provider.fetchTranscript(videoMatch.videoId, { fetch: fetcher, html, lang: request.lang });
    if (result.title) title = result.title;
    if (!text && result.description) text = result.description;
    const { text: truncatedTranscript, truncated: transcriptTruncated } = truncateUtf8(result.text, maxBytes);
    video = {
      provider: result.provider,
      videoId: result.videoId,
      lang: result.lang,
      channel: result.channel,
      description: result.description,
      transcript: truncatedTranscript,
      entries: result.entries.length,
      truncated: transcriptTruncated,
    };

    const wantComments = request.comments ?? gaiaWebFetchCommentsDefault();
    if (wantComments && videoMatch.provider.fetchComments) {
      const max = typeof request.comments === "number" ? request.comments : gaiaWebFetchCommentsMax();
      const commentsResult = await videoMatch.provider.fetchComments(videoMatch.videoId, { fetch: fetcher, html, max });
      if (commentsResult.comments) video.comments = commentsResult.comments;
      else video.commentsUnavailable = commentsResult.reason ?? (commentsResult.ok ? "no comments found" : "comments fetch failed");
    }
  }

  if (!video && text.length < 100) throw new Error(`could not extract readable content from ${parsed.hostname}`);

  const { text: truncatedText, truncated } = truncateUtf8(text, maxBytes);
  return { url: parsed.toString(), title, text: truncatedText, bytes: Buffer.byteLength(truncatedText, "utf8"), truncated, ...(video ? { video } : {}) };
}
