import { test } from "bun:test";
import assert from "node:assert/strict";
import { findVideoTranscriptProvider, VIDEO_TRANSCRIPT_PROVIDERS } from "../src/services/video-transcript.js";

const youtube = VIDEO_TRANSCRIPT_PROVIDERS.find((p) => p.name === "youtube");
if (!youtube) throw new Error("youtube provider not registered");

const API_KEY = "TEST_INNERTUBE_KEY";
const CLIENT_VERSION = "2.20260820.01.00";
const COMMENT_TOKEN = "TEST_COMMENT_TOKEN";

function watchHtml(opts: { withCommentsSection?: boolean } = {}): string {
  const initialData = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: opts.withCommentsSection === false ? [] : [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      continuationItemRenderer: {
                        continuationEndpoint: {
                          commandMetadata: { webCommandMetadata: { apiUrl: "/youtubei/v1/next" } },
                          continuationCommand: { token: COMMENT_TOKEN, request: "CONTINUATION_REQUEST_TYPE_WATCH_NEXT" },
                        },
                      },
                    },
                  ],
                  sectionIdentifier: "comment-item-section",
                  targetId: "comments-section",
                },
              },
            ],
          },
        },
      },
    },
  };
  return `<html><head><script>var ytcfg={};ytcfg.set({"INNERTUBE_API_KEY":"${API_KEY}","INNERTUBE_CLIENT_VERSION":"${CLIENT_VERSION}"});var ytInitialData = ${JSON.stringify(initialData)};</script></head><body></body></html>`;
}

const PLAYER_RESPONSE = {
  videoDetails: { title: "Fixture Video Title", author: "Fixture Channel", shortDescription: "Fixture description." },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { languageCode: "de", kind: "asr", baseUrl: "https://captions.example/de.xml" },
        { languageCode: "en", baseUrl: "https://captions.example/en.xml" },
      ],
    },
  },
};

const CAPTION_XML_EN = `<transcript><text start="0.0" dur="1.5">Hello &amp; welcome</text><text start="1.5" dur="2.0">Second line</text></transcript>`;

test("youtube provider matchUrl recognizes watch/short/youtu.be/embed urls and rejects others", () => {
  const cases: Array<[string, string | null]> = [
    ["https://www.youtube.com/watch?v=abcdefghijk", "abcdefghijk"],
    ["https://youtu.be/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/shorts/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
    ["https://m.youtube.com/watch?v=abcdefghijk&t=3s", "abcdefghijk"],
    ["https://example.com/watch?v=abcdefghijk", null],
    ["https://vimeo.com/12345", null],
  ];
  for (const [url, expected] of cases) {
    assert.equal(youtube!.matchUrl(new URL(url)), expected, url);
  }
});

test("findVideoTranscriptProvider dispatches to the matching registered provider", () => {
  const found = findVideoTranscriptProvider(new URL("https://www.youtube.com/watch?v=abcdefghijk"));
  assert.equal(found?.provider.name, "youtube");
  assert.equal(found?.videoId, "abcdefghijk");
  assert.equal(findVideoTranscriptProvider(new URL("https://example.com")), null);
});

test("fetchTranscript selects the requested language, falls back per rank order, and decodes entities", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://www.youtube.com/youtubei/v1/player")) return Response.json(PLAYER_RESPONSE);
    if (url === "https://captions.example/en.xml") return new Response(CAPTION_XML_EN, { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await youtube!.fetchTranscript("abcdefghijk", { fetch: fetcher, html: watchHtml(), lang: "en" });
  assert.equal(result.provider, "youtube");
  assert.equal(result.lang, "en");
  assert.equal(result.title, "Fixture Video Title");
  assert.equal(result.channel, "Fixture Channel");
  assert.equal(result.description, "Fixture description.");
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].text, "Hello & welcome");
  assert.match(result.text, /\[0:00\] Hello & welcome/);
  assert.match(result.text, /\[0:01\] Second line/);
  assert.ok(calls.some((u) => u.startsWith("https://www.youtube.com/youtubei/v1/player")));
});

test("fetchTranscript throws a clear error when the video has no captions", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).startsWith("https://www.youtube.com/youtubei/v1/player")) {
      return Response.json({ videoDetails: { title: "No captions" } });
    }
    throw new Error("unexpected fetch");
  };
  await assert.rejects(youtube!.fetchTranscript("abcdefghijk", { fetch: fetcher, html: watchHtml() }), /no captions available/);
});

const ENTITY_COMMENTS_RESPONSE = {
  frameworkUpdates: {
    entityBatchUpdate: {
      mutations: [
        { entityKey: "k1", type: "X", payload: { commentEntityPayload: {
          author: { displayName: "@alice" },
          properties: { content: { content: "first comment" } },
          toolbar: { likeCountA11y: "304K likes" },
        } } },
        { entityKey: "k2", type: "X", payload: { commentSurfaceEntityPayload: {} } },
        { entityKey: "k3", type: "X", payload: { commentEntityPayload: {
          author: { displayName: "@bob" },
          properties: { content: { content: "second comment" } },
          toolbar: { likeCountNotliked: "12" },
        } } },
        { entityKey: "k4", type: "X", payload: { commentEntityPayload: {
          author: { displayName: "@carol" },
          properties: { content: { content: "third comment, no likes field" } },
          toolbar: {},
        } } },
      ],
    },
  },
};

test("fetchComments parses the entityBatchUpdate shape (author/text/likes) up to max", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://www.youtube.com/youtubei/v1/next")) return Response.json(ENTITY_COMMENTS_RESPONSE);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await youtube!.fetchComments!("abcdefghijk", { fetch: fetcher, html: watchHtml(), max: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.comments?.length, 2);
  assert.deepEqual(result.comments?.[0], { author: "@alice", text: "first comment", likes: 304_000 });
  assert.deepEqual(result.comments?.[1], { author: "@bob", text: "second comment", likes: 12 });
});

test("fetchComments falls back to legacy commentRenderer shape when no entity payloads are present", async () => {
  const legacyResponse = {
    onResponseReceivedEndpoints: [
      { appendContinuationItemsAction: { continuationItems: [
        { commentThreadRenderer: { comment: { commentRenderer: {
          authorText: { simpleText: "@dave" },
          contentText: { runs: [{ text: "legacy shape comment" }] },
          voteCount: { simpleText: "1.2K" },
        } } } },
      ] } },
    ],
  };
  const fetcher: typeof fetch = async () => Response.json(legacyResponse);
  const result = await youtube!.fetchComments!("abcdefghijk", { fetch: fetcher, html: watchHtml(), max: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.comments?.[0], { author: "@dave", text: "legacy shape comment", likes: 1_200 });
});

test("fetchComments soft-degrades (ok:true, comments:null, reason) when the comments continuation can't be located", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("must not fetch when no token was found"); };
  const result = await youtube!.fetchComments!("abcdefghijk", { fetch: fetcher, html: watchHtml({ withCommentsSection: false }), max: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.comments, null);
  assert.match(result.reason ?? "", /token|structure/i);
});

test("fetchComments soft-degrades when the response parses but no comment shape matches (innertube shape shift)", async () => {
  const fetcher: typeof fetch = async () => Response.json({ frameworkUpdates: { entityBatchUpdate: { mutations: [] } } });
  const result = await youtube!.fetchComments!("abcdefghijk", { fetch: fetcher, html: watchHtml(), max: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.comments, null);
  assert.match(result.reason ?? "", /shape/i);
});

test("fetchComments reports ok:false only on a genuine network/HTTP failure", async () => {
  const fetcher: typeof fetch = async () => new Response("server error", { status: 500 });
  const result = await youtube!.fetchComments!("abcdefghijk", { fetch: fetcher, html: watchHtml(), max: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.comments, null);
  assert.match(result.reason ?? "", /500/);
});
