import test from "node:test";
import assert from "node:assert/strict";
import { extractReadable, fetchWeb } from "../src/services/web-fetch.js";
import type { VideoTranscriptProvider } from "../src/services/video-transcript.js";

const ARTICLE_HTML = `<!doctype html>
<html>
<head>
<title>Example Article -- Test Fixture</title>
<style>body { color: red; }</style>
<script>window.trackingJunk = 1;</script>
</head>
<body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<header><h1 class="sitename">SiteName</h1></header>
<article>
<h1>Example Article Heading</h1>
<p>This is the first paragraph of real article content, long enough to clear the extraction floor comfortably on its own so the test does not depend on any other paragraph being present in the fixture.</p>
<p>This is a second paragraph with more real content, again padded out with enough filler words that byte-length truncation tests further down this file have something meaningful to cut in half.</p>
<ul><li>First point</li><li>Second point</li></ul>
</article>
<aside>Related links go here, not article content.</aside>
<footer>Copyright 2026</footer>
<script>console.log("noise");</script>
</body>
</html>`;

test("extractReadable strips chrome and keeps headings/paragraphs/list items", async () => {
  const { title, text } = await extractReadable(ARTICLE_HTML);
  assert.equal(title, "Example Article -- Test Fixture");
  assert.match(text, /# Example Article Heading/);
  assert.match(text, /first paragraph of real article content/);
  assert.match(text, /- First point/);
  assert.match(text, /- Second point/);
  assert.doesNotMatch(text, /trackingJunk/);
  assert.doesNotMatch(text, /console\.log/);
  assert.doesNotMatch(text, /Related links go here/);
  assert.doesNotMatch(text, /Copyright 2026/);
  assert.doesNotMatch(text, /color: red/);
});

test("fetchWeb returns clean extracted text, not raw HTML", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(ARTICLE_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
  };
  const response = await fetchWeb({ url: "https://example.com/article" }, { fetch: fetcher });
  assert.equal(calls.length, 1);
  assert.equal(response.title, "Example Article -- Test Fixture");
  assert.equal(response.url, "https://example.com/article");
  assert.match(response.text, /# Example Article Heading/);
  assert.doesNotMatch(response.text, /<article>/);
  assert.doesNotMatch(response.text, /<script>/);
  assert.equal(response.truncated, false);
  assert.equal(response.bytes, Buffer.byteLength(response.text, "utf8"));
});

test("fetchWeb truncates to maxBytes on a UTF-8 boundary", async () => {
  const fetcher: typeof fetch = async () => new Response(ARTICLE_HTML, { status: 200 });
  const response = await fetchWeb({ url: "https://example.com/article", maxBytes: 40 }, { fetch: fetcher });
  assert.equal(response.truncated, true);
  assert.ok(response.bytes <= 40, `expected <=40 bytes, got ${response.bytes}`);
  // A truncated prefix must still be valid UTF-8 (no split multi-byte codepoint).
  assert.doesNotThrow(() => Buffer.from(response.text, "utf8").toString("utf8"));
});

test("fetchWeb rejects non-http(s) schemes and empty urls", async () => {
  await assert.rejects(fetchWeb({ url: "" }, {}), /requires a url/);
  await assert.rejects(fetchWeb({ url: "file:///etc/passwd" }, {}), /unsupported url scheme/);
  await assert.rejects(fetchWeb({ url: "not a url" }, {}), /invalid url/);
});

test("fetchWeb surfaces a clear error on non-2xx responses", async () => {
  const fetcher: typeof fetch = async () => new Response("nope", { status: 404 });
  await assert.rejects(fetchWeb({ url: "https://example.com/missing" }, { fetch: fetcher }), /HTTP 404/);
});

test("fetchWeb errors when extraction yields too little content and no video match", async () => {
  const fetcher: typeof fetch = async () => new Response("<html><body><p>hi</p></body></html>", { status: 200 });
  await assert.rejects(fetchWeb({ url: "https://example.com/thin" }, { fetch: fetcher }), /could not extract readable content/);
});

function fakeVideoProvider(): { provider: VideoTranscriptProvider; calls: { transcript: number; comments: number } } {
  const calls = { transcript: 0, comments: 0 };
  const provider: VideoTranscriptProvider = {
    name: "fake",
    matchUrl: (url) => (url.hostname === "video.example" ? "vid123" : null),
    fetchTranscript: async (videoId) => {
      calls.transcript++;
      return {
        provider: "fake",
        videoId,
        lang: "en",
        title: "Fake Video Title",
        channel: "Fake Channel",
        description: "Fake video description text.",
        entries: [{ offset: 0, duration: 2, text: "hello" }, { offset: 2, duration: 2, text: "world" }],
        text: "[0:00] hello\n[0:02] world",
      };
    },
    fetchComments: async (videoId, { max }) => {
      calls.comments++;
      const all = [
        { author: "@alice", text: "great video", likes: 12 },
        { author: "@bob", text: "nice", likes: 3 },
        { author: "@carol", text: "thanks" },
      ];
      return { ok: true, comments: all.slice(0, max) };
    },
  };
  return { provider, calls };
}

test("fetchWeb attaches a video transcript by default for a matched provider", async () => {
  const { provider, calls } = fakeVideoProvider();
  const fetcher: typeof fetch = async () => new Response("<html><head><title>t</title></head><body><p>short</p></body></html>", { status: 200 });
  const response = await fetchWeb({ url: "https://video.example/watch?v=vid123" }, { fetch: fetcher, videoProviders: [provider] });
  assert.equal(calls.transcript, 1);
  assert.equal(calls.comments, 0, "comments must default OFF");
  assert.ok(response.video);
  assert.equal(response.video?.provider, "fake");
  assert.equal(response.video?.videoId, "vid123");
  assert.equal(response.title, "Fake Video Title");
  assert.match(response.video?.transcript ?? "", /hello/);
  assert.equal(response.video?.entries, 2);
  assert.equal(response.video?.comments, undefined);
});

test("fetchWeb transcript:false opts a matched video out", async () => {
  const { provider, calls } = fakeVideoProvider();
  const fetcher: typeof fetch = async () => new Response("<html><body><p>plenty of real non-video page text here so extraction succeeds on its own merits without any video fallback kicking in at all.</p></body></html>", { status: 200 });
  const response = await fetchWeb({ url: "https://video.example/watch?v=vid123", transcript: false }, { fetch: fetcher, videoProviders: [provider] });
  assert.equal(calls.transcript, 0);
  assert.equal(response.video, undefined);
});

test("fetchWeb comments:true attaches the configured default count", async () => {
  const { provider, calls } = fakeVideoProvider();
  const fetcher: typeof fetch = async () => new Response("<html><body><p>x</p></body></html>", { status: 200 });
  const response = await fetchWeb({ url: "https://video.example/watch?v=vid123", comments: true }, { fetch: fetcher, videoProviders: [provider] });
  assert.equal(calls.comments, 1);
  assert.equal(response.video?.comments?.length, 3);
  assert.deepEqual(response.video?.comments?.[0], { author: "@alice", text: "great video", likes: 12 });
});

test("fetchWeb comments:N caps the count explicitly", async () => {
  const { provider } = fakeVideoProvider();
  const fetcher: typeof fetch = async () => new Response("<html><body><p>x</p></body></html>", { status: 200 });
  const response = await fetchWeb({ url: "https://video.example/watch?v=vid123", comments: 2 }, { fetch: fetcher, videoProviders: [provider] });
  assert.equal(response.video?.comments?.length, 2);
});

test("fetchWeb soft-degrades when comments are requested but the provider can't parse any", async () => {
  const provider: VideoTranscriptProvider = {
    name: "fake",
    matchUrl: (url) => (url.hostname === "video.example" ? "vid123" : null),
    fetchTranscript: async (videoId) => ({ provider: "fake", videoId, lang: "en", entries: [{ offset: 0, duration: 1, text: "hi" }], text: "[0:00] hi" }),
    fetchComments: async () => ({ ok: true, comments: null, reason: "innertube shape changed" }),
  };
  const fetcher: typeof fetch = async () => new Response("<html><body><p>x</p></body></html>", { status: 200 });
  const response = await fetchWeb({ url: "https://video.example/watch?v=vid123", comments: true }, { fetch: fetcher, videoProviders: [provider] });
  assert.equal(response.video?.comments, undefined);
  assert.equal(response.video?.commentsUnavailable, "innertube shape changed");
});
