// Provider-pluggable video-transcript + top-level-comments extraction for
// `gaia web fetch`. Port of ~/.gaia/skills/youtube-transcript/transcript.js
// (kept untouched on disk as a standalone fallback) into the daemon so the
// gaia web verb can attach it automatically when a fetch url matches a video
// provider. Comments are a separate, reverse-engineered Innertube endpoint
// verified live against a real watch page (2026-08-21) -- see fetchComments
// doc comment for the exact response shape and its soft-degrade contract.

import { gaiaVideoTranscriptDefaultLang } from "../core/config.js";

export interface VideoTranscriptEntry {
  offset: number;
  duration: number;
  text: string;
}

export interface VideoTranscriptResult {
  provider: string;
  videoId: string;
  lang: string;
  title?: string;
  channel?: string;
  description?: string;
  entries: VideoTranscriptEntry[];
  /** "[mm:ss] text" lines joined, same shape as the skill's stdout. */
  text: string;
}

export interface VideoComment {
  author: string;
  text: string;
  likes?: number;
}

export interface VideoCommentsResult {
  /** false only on a hard failure (network/HTTP error reaching Innertube).
   * An Innertube response that parsed but didn't match any known comment
   * shape is still ok:true with comments:null + a reason -- "shape shifted",
   * not "broken". */
  ok: boolean;
  comments: VideoComment[] | null;
  reason?: string;
}

export interface VideoProviderFetchOptions {
  fetch?: typeof globalThis.fetch;
  lang?: string;
  /** Pre-fetched watch/canonical page HTML, when the caller (web fetch) already
   * has it -- avoids a duplicate request. */
  html?: string;
}

export interface VideoProviderCommentsOptions extends VideoProviderFetchOptions {
  max: number;
}

export interface VideoTranscriptProvider {
  name: string;
  /** Returns the provider-specific video id if this url matches, else null.
   * Pattern-matching only (no network) so callers can cheaply test a url
   * before deciding to fetch anything. */
  matchUrl(url: URL): string | null;
  fetchTranscript(videoId: string, options?: VideoProviderFetchOptions): Promise<VideoTranscriptResult>;
  /** Optional: not every provider exposes comments. */
  fetchComments?(videoId: string, options: VideoProviderCommentsOptions): Promise<VideoCommentsResult>;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---- shared helpers -------------------------------------------------------

/** Scans `source` for the first `marker`, then balance-matches braces from the
 * next `{` to extract one JSON object as text (string-literal aware, so a
 * `}` inside a quoted value never closes early). Inline `<script>` blobs like
 * `var ytInitialData = {...};` aren't valid JSON documents on their own (no
 * safe end-of-object marker besides matching braces), so a regex `.*}` would
 * either under- or over-match; this is the general fix. */
function extractBalancedJson(source: string, markers: string[]): unknown | undefined {
  for (const marker of markers) {
    const markerIdx = source.indexOf(marker);
    if (markerIdx === -1) continue;
    const braceStart = source.indexOf("{", markerIdx);
    if (braceStart === -1) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(source.slice(braceStart, i + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

/** Depth-first search for the first plain-object node matching `predicate`. */
function findNode(root: unknown, predicate: (node: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (predicate(record)) return record;
    for (const value of Object.values(record)) stack.push(value);
  }
  return undefined;
}

/** Depth-first collection of every plain-object node matching `predicate`,
 * in document order (used for entityBatchUpdate mutations, which arrive as a
 * flat array already, but kept generic for future provider reuse). */
function collectNodes(root: unknown, predicate: (node: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (predicate(record)) out.push(record);
    const entries = Object.entries(record).reverse();
    for (const [, value] of entries) stack.push(value);
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---- YouTube ----------------------------------------------------------

function extractVideoId(input: string): string | null {
  const match = input.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function matchYoutubeUrl(url: URL): string | null {
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  if (host !== "youtube.com" && host !== "youtu.be") return null;
  return extractVideoId(url.href);
}

function baseLang(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? "";
}

interface CaptionTrack {
  languageCode: string;
  kind?: string;
  baseUrl?: string;
  url?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

// Preference order (no hardcoded track index): 1) exact code match, manual
// before auto; 2) same base language, manual before auto; 3) any other
// track, manual before auto.
function selectTrack(tracks: CaptionTrack[], wanted: string): CaptionTrack | undefined {
  const want = wanted.toLowerCase();
  const rank = (t: CaptionTrack): number => {
    const code = String(t.languageCode || "").toLowerCase();
    const auto = t.kind === "asr" ? 1 : 0;
    if (code === want) return 0 + auto;
    if (baseLang(code) === baseLang(want)) return 2 + auto;
    return 4 + auto;
  };
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0];
}

function decodeEntities(text: string): string {
  return text
    .replace(/\n/g, " ")
    .replace(/&amp;#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function extractInnertubeApiKey(html: string): string | undefined {
  return (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || html.match(/INNERTUBE_API_KEY\\":\\"([^\\"]+)\\"/))?.[1];
}

function extractInnertubeClientVersion(html: string): string | undefined {
  return html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
}

async function fetchWatchHtml(videoId: string, fetcher: typeof globalThis.fetch): Promise<string> {
  const res = await fetcher(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US" },
  });
  if (!res.ok) throw new Error(`video page HTTP ${res.status}`);
  return res.text();
}

async function fetchYoutubeTranscript(videoId: string, options: VideoProviderFetchOptions = {}): Promise<VideoTranscriptResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const lang = options.lang ?? gaiaVideoTranscriptDefaultLang();
  const html = options.html ?? (await fetchWatchHtml(videoId, fetcher));
  if (html.includes('class="g-recaptcha"')) throw new Error("rate limited by YouTube");

  const key = extractInnertubeApiKey(html);
  if (!key) throw new Error("could not extract Innertube API key");

  const playerRes = await fetcher(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId }),
  });
  if (!playerRes.ok) throw new Error(`player HTTP ${playerRes.status}`);
  const json = (await playerRes.json()) as Record<string, unknown>;

  const details = (json.videoDetails ?? {}) as Record<string, unknown>;
  const captions = (json.captions as Record<string, unknown> | undefined)?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const tracks = captions?.captionTracks as CaptionTrack[] | undefined;
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error(`no captions available for ${videoId}`);

  const track = selectTrack(tracks, lang);
  if (!track) throw new Error(`no caption tracks for ${videoId}`);

  const trackUrl = (track.baseUrl || track.url || "").replace(/&fmt=[^&]+/, "");
  if (!trackUrl) throw new Error("caption track has no url");
  const transcriptRes = await fetcher(trackUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!transcriptRes.ok) throw new Error(`transcript HTTP ${transcriptRes.status}`);
  const body = await transcriptRes.text();
  const RE_XML = /<text start="([^"]*)" dur="([^"]*)">([\s\S]*?)<\/text>/g;
  const entries: VideoTranscriptEntry[] = [...body.matchAll(RE_XML)].map((m) => ({
    offset: Number.parseFloat(m[1]),
    duration: Number.parseFloat(m[2]),
    text: decodeEntities(m[3]),
  }));
  if (entries.length === 0) throw new Error("transcript empty or unparseable");

  return {
    provider: "youtube",
    videoId,
    lang: track.languageCode,
    title: str(details.title) || undefined,
    channel: str(details.author) || undefined,
    description: str(details.shortDescription) || undefined,
    entries,
    text: entries.map((e) => `[${formatTimestamp(e.offset)}] ${e.text}`).join("\n"),
  };
}

/** Top-level video comments via YouTube's internal Innertube `/youtubei/v1/next`
 * continuation (no API key auth beyond the public `key=` query param already
 * used for captions -- verified live 2026-08-21 against a real watch page):
 *
 * 1. The watch-page's inline `ytInitialData` has an `itemSectionRenderer` with
 *    `sectionIdentifier: "comment-item-section"`; its
 *    `contents[0].continuationItemRenderer.continuationEndpoint.continuationCommand.token`
 *    bootstraps the comments continuation (POST target from the same node's
 *    `commandMetadata.webCommandMetadata.apiUrl`, normally `/youtubei/v1/next`).
 * 2. POSTing `{ context, continuation: token }` there returns
 *    `frameworkUpdates.entityBatchUpdate.mutations[]`, a flat list of entities
 *    (not nested under the comment thread tree) -- comment ones carry
 *    `payload.commentEntityPayload` with `.author.displayName`,
 *    `.properties.content.content` (text), `.toolbar.likeCountA11y` /
 *    `.likeCountNotliked` (likes, human-formatted e.g. "304K"). Only
 *    top-level threads are present here; replies need their own continuation
 *    this function never follows.
 *
 * This is reverse-engineered, undocumented, and YouTube has migrated the
 * comment renderer shape before (legacy `commentRenderer` -> today's
 * entity-payload model) -- any step failing to locate what it expects
 * degrades to `{ ok: true, comments: null, reason }` rather than throwing;
 * only a genuine network/HTTP failure reaching Innertube sets `ok: false`. */
async function fetchYoutubeComments(videoId: string, options: VideoProviderCommentsOptions): Promise<VideoCommentsResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const html = options.html ?? (await fetchWatchHtml(videoId, fetcher));
    const key = extractInnertubeApiKey(html);
    const clientVersion = extractInnertubeClientVersion(html);
    if (!key || !clientVersion) return { ok: true, comments: null, reason: "could not extract Innertube key/client version (page structure changed)" };

    const initialData = extractBalancedJson(html, ["var ytInitialData = ", 'ytInitialData"] = ', "ytInitialData = "]);
    if (!initialData) return { ok: true, comments: null, reason: "could not locate ytInitialData (page structure changed)" };

    const commentsSection = findNode(initialData, (node) => node.sectionIdentifier === "comment-item-section");
    const contents = commentsSection?.contents;
    const first = Array.isArray(contents) ? (contents[0] as Record<string, unknown> | undefined) : undefined;
    const continuationItem = first?.continuationItemRenderer as Record<string, unknown> | undefined;
    const continuationEndpoint = continuationItem?.continuationEndpoint as Record<string, unknown> | undefined;
    const continuationCommand = continuationEndpoint?.continuationCommand as Record<string, unknown> | undefined;
    const token = str(continuationCommand?.token);
    if (!token) return { ok: true, comments: null, reason: "no comments continuation token found (page structure changed, or comments disabled)" };

    const apiUrl = str((((continuationEndpoint?.commandMetadata as Record<string, unknown> | undefined)?.webCommandMetadata as Record<string, unknown> | undefined)?.apiUrl)) || "/youtubei/v1/next";

    const nextRes = await fetcher(`https://www.youtube.com${apiUrl}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" } }, continuation: token }),
    });
    if (!nextRes.ok) return { ok: false, comments: null, reason: `comments continuation HTTP ${nextRes.status}` };
    const nextJson = await nextRes.json();

    const mutations = collectNodes(nextJson, (node) => Boolean(node.commentEntityPayload));
    const comments: VideoComment[] = [];
    for (const mutation of mutations) {
      const payload = mutation.commentEntityPayload as Record<string, unknown>;
      const author = str((payload.author as Record<string, unknown> | undefined)?.displayName);
      const text = str(((payload.properties as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)?.content);
      if (!text) continue;
      const toolbar = payload.toolbar as Record<string, unknown> | undefined;
      const likesRaw = str(toolbar?.likeCountA11y) || str(toolbar?.likeCountNotliked) || str(toolbar?.likeCountLiked);
      const likes = parseLikeCount(likesRaw);
      comments.push({ author, text, ...(likes === undefined ? {} : { likes }) });
      if (comments.length >= options.max) break;
    }

    if (comments.length === 0) {
      // Legacy fallback: older/alternate clients can still return the
      // pre-entity-payload commentRenderer shape directly in the tree.
      const legacy = collectNodes(nextJson, (node) => Boolean(node.commentRenderer));
      for (const node of legacy) {
        const cr = node.commentRenderer as Record<string, unknown>;
        const authorText = cr.authorText as Record<string, unknown> | undefined;
        const author = str(authorText?.simpleText) || str((authorText?.runs as Array<Record<string, unknown>> | undefined)?.[0]?.text);
        const contentRuns = ((cr.contentText as Record<string, unknown> | undefined)?.runs as Array<Record<string, unknown>> | undefined) ?? [];
        const text = contentRuns.map((r) => str(r.text)).join("");
        if (!text) continue;
        const likes = parseLikeCount(str((cr.voteCount as Record<string, unknown> | undefined)?.simpleText));
        comments.push({ author, text, ...(likes === undefined ? {} : { likes }) });
        if (comments.length >= options.max) break;
      }
    }

    if (comments.length === 0) return { ok: true, comments: null, reason: "comments continuation returned no parseable comment entities (innertube shape may have changed)" };
    return { ok: true, comments };
  } catch (error) {
    return { ok: false, comments: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** "304K likes" / "304K" / "1.2K" / "12" -> a number. Undefined when unparseable. */
function parseLikeCount(raw: string): number | undefined {
  if (!raw) return undefined;
  const match = raw.replace(/,/g, "").match(/^([\d.]+)\s*([KMB]?)/i);
  if (!match) return undefined;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2].toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

const youtubeProvider: VideoTranscriptProvider = {
  name: "youtube",
  matchUrl: matchYoutubeUrl,
  fetchTranscript: fetchYoutubeTranscript,
  fetchComments: fetchYoutubeComments,
};

/** Registered video-transcript providers, in match-priority order. Adding a
 * provider (e.g. Vimeo) is one more entry here -- no caller changes. */
export const VIDEO_TRANSCRIPT_PROVIDERS: VideoTranscriptProvider[] = [youtubeProvider];

/** First registered provider whose matchUrl() recognizes this url, plus the
 * video id it extracted. */
export function findVideoTranscriptProvider(
  url: URL,
  providers: VideoTranscriptProvider[] = VIDEO_TRANSCRIPT_PROVIDERS,
): { provider: VideoTranscriptProvider; videoId: string } | null {
  for (const provider of providers) {
    const videoId = provider.matchUrl(url);
    if (videoId) return { provider, videoId };
  }
  return null;
}
