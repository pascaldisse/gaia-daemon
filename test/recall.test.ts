import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { searchTranscript } from "../src/memory/recall.ts";
import { createTempDir } from "./helpers/temp.ts";

function line(author: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, timestamp: "2026-06-12T10:00:00.000Z", author, text, ...extra });
}

async function fixture(temp: { path: string }, lines: string[]): Promise<{ transcriptPath: string; dbPath: string }> {
  const roomDir = join(temp.path, "rooms", "default");
  await mkdir(roomDir, { recursive: true });
  const transcriptPath = join(roomDir, "transcript.jsonl");
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return { transcriptPath, dbPath: join(roomDir, "recall.db") };
}

test("recall finds past messages by content", async () => {
  const temp = await createTempDir();
  try {
    const { transcriptPath, dbPath } = await fixture(temp, [
      line("user", "let's discuss the voice latency budget"),
      line("gaia", "the latency target is five hundred milliseconds"),
      line("user", "unrelated grocery list"),
    ]);

    const hits = searchTranscript(transcriptPath, dbPath, "latency");
    assert.equal(hits.length, 2);
    assert.equal(hits.some((hit) => hit.author === "gaia"), true);
    assert.equal(hits.every((hit) => hit.snippet.includes("latency")), true);
  } finally {
    await temp.cleanup();
  }
});

test("recall syncs incrementally as the transcript grows", async () => {
  const temp = await createTempDir();
  try {
    const first = [line("user", "alpha topic")];
    const { transcriptPath, dbPath } = await fixture(temp, first);
    assert.equal(searchTranscript(transcriptPath, dbPath, "alpha").length, 1);
    assert.equal(searchTranscript(transcriptPath, dbPath, "beta").length, 0);

    await writeFile(transcriptPath, `${[...first, line("gaia", "beta topic")].join("\n")}\n`, "utf8");
    assert.equal(searchTranscript(transcriptPath, dbPath, "beta").length, 1);
    assert.equal(searchTranscript(transcriptPath, dbPath, "alpha").length, 1);
  } finally {
    await temp.cleanup();
  }
});

test("recall rebuilds when the transcript shrinks", async () => {
  const temp = await createTempDir();
  try {
    const { transcriptPath, dbPath } = await fixture(temp, [line("user", "one"), line("user", "two"), line("user", "three")]);
    assert.equal(searchTranscript(transcriptPath, dbPath, "two").length, 1);

    await writeFile(transcriptPath, `${line("user", "only survivor")}\n`, "utf8");
    assert.equal(searchTranscript(transcriptPath, dbPath, "two").length, 0);
    assert.equal(searchTranscript(transcriptPath, dbPath, "survivor").length, 1);
  } finally {
    await temp.cleanup();
  }
});

test("recall tolerates free-form queries, voice channels, and missing transcripts", async () => {
  const temp = await createTempDir();
  try {
    const { transcriptPath, dbPath } = await fixture(temp, [line("gaia", "we settled on sqlite", { channel: "voice" })]);

    const hits = searchTranscript(transcriptPath, dbPath, 'what did we say about "sqlite" (the db)?');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.channel, "voice");

    assert.deepEqual(searchTranscript(transcriptPath, dbPath, "   "), []);
    assert.deepEqual(searchTranscript(join(temp.path, "missing.jsonl"), join(temp.path, "missing.db"), "anything"), []);
  } finally {
    await temp.cleanup();
  }
});
