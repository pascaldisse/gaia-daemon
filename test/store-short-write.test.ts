import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonlBatchDurable, appendJsonlDurable, writeAll, type ByteWriter } from "../src/core/store.js";

/** Fake fd that accepts at most `chunk` bytes per call — what a real write(2)
 * is allowed to do (pipe/NFS/signal) and what the old code silently dropped. */
function shortWriter(chunk: number): ByteWriter & { readonly out: () => string } {
  const parts: Buffer[] = [];
  return {
    async write(buffer: Uint8Array, offset: number, length: number) {
      const n = Math.min(chunk, length);
      parts.push(Buffer.from(buffer.subarray(offset, offset + n)));
      return { bytesWritten: n };
    },
    out: () => Buffer.concat(parts).toString("utf8"),
  };
}

test("writeAll retries short writes until the whole payload is out", async () => {
  const w = shortWriter(3);
  const payload = `${JSON.stringify({ id: "e1", text: "ümlaut payload" })}\n`;
  await writeAll(w, payload);
  assert.equal(w.out(), payload);
});

test("writeAll throws instead of reporting a durable partial write", async () => {
  const stalled: ByteWriter = { async write() { return { bytesWritten: 0 }; } };
  await assert.rejects(() => writeAll(stalled, "abc"), /short write/);
});

test("durable appends write every byte through real file I/O", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-store-"));
  const path = join(dir, "log.jsonl");
  try {
    await appendJsonlDurable(path, { id: "a" });
    await appendJsonlBatchDurable(path, Array.from({ length: 4000 }, (_, i) => ({ id: i, pad: "x".repeat(600) })));
    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 4001);
    assert.deepEqual(JSON.parse(lines[0]!), { id: "a" });
    assert.deepEqual(JSON.parse(lines[4000]!), { id: 3999, pad: "x".repeat(600) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
