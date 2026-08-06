import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../src2");
const LAYERS = ["core", "domain", "harness"];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

test("v2 shared layers keep harness abstraction and downward imports", async () => {
  const files = (await Promise.all(LAYERS.map((layer) => sourceFiles(join(ROOT, layer))))).flat();
  const contents = await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")] as const));

  for (const [path, source] of contents) {
    assert.doesNotMatch(source, /(?<![.\w])harness\s*(!==|===)/, `${path} branches on harness identity`);
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:server|daemon|services)\//, `${path} imports upward`);
  }
});
