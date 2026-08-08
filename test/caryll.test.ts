import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressCaryll, expandCaryll } from "../src/services/caryll.js";

test("round-trips MEMORY-DESIGN.md exactly", async () => {
  const text = await readFile(new URL("../MEMORY-DESIGN.md", import.meta.url), "utf8");
  const compressed = compressCaryll(text);
  assert.equal(expandCaryll(compressed.output), text);
});

test("round-trips README.md exactly", async () => {
  const text = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const compressed = compressCaryll(text);
  assert.equal(expandCaryll(compressed.output), text);
});

test("preserves verbatim code and URLs while avoiding alias collisions", () => {
  const repeated = "carries durable context across rooms";
  const text = [
    "~A1 already exists, so the default numbered alias prefix must collide.",
    Array.from({ length: 12 }, () => `${repeated}.`).join(" "),
    "`carries durable context across rooms` stays inline.",
    "```ts",
    "const sample = 'carries durable context across rooms';",
    "```",
    "https://example.test/memory/service/carries/durable/context/across/rooms stays URL.",
  ].join("\n");

  const compressed = compressCaryll(text);
  assert.equal(expandCaryll(compressed.output), text);
  assert.match(compressed.output, /^~caryll\/1\n~L ~B1=/m);
  assert.doesNotMatch(compressed.output, /^~L ~A1=/m);
  assert.match(compressed.output, /`carries durable context across rooms`/);
  assert.match(compressed.output, /https:\/\/example\.test\/memory\/service\/carries\/durable\/context\/across\/rooms/);
});

test("rejects missing Caryll header", () => {
  assert.throws(() => expandCaryll("not-caryll\n~~\nbody"), /~caryll\/1/);
});

test("round-trips episodes.jsonl copy and reaches measured substring-miner floor", async () => {
  const source = "/Users/pascaldisse/.gaia/agents/nyari/persona/memory/episodes.jsonl";
  const dir = await mkdtemp(join(tmpdir(), "caryll-episodes-"));
  const copy = join(dir, "episodes.jsonl");
  await copyFile(source, copy);
  const text = await readFile(copy, "utf8");
  const compressed = compressCaryll(text);
  assert.equal(expandCaryll(compressed.output), text);
  assert.ok(
    compressed.stats.tokensAfter <= 0.88 * compressed.stats.tokensBefore,
    `expected <= 0.88 ratio, got ${compressed.stats.tokensAfter / compressed.stats.tokensBefore}`,
  );
});
