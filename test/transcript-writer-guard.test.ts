// transcript-writer-guard — regression aid ONLY. It greps src/ + scripts/ for
// code that writes transcript.jsonl outside RoomHandle, which is where the
// room lock lives. It is a lint, NOT a security boundary: any process on the
// box can write the file directly, and a writer this pattern does not match
// (a helper, a dynamic path, a shell-out) passes silently. It exists so the
// coordination added in rooms.ts is not quietly bypassed again by new code.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// rooms.ts IS the coordinated writer; paths.ts only names the file; the
// workspace room seed uses exclusive `wx` create-only (never a rewrite).
const ALLOWED = new Set(["src/domain/rooms.ts", "src/core/paths.ts", "src/domain/workspace.ts"]);
const WRITE = /\b(writeFile|writeFileSync|appendFile|appendFileSync|writeText|writeTextAtomic|appendJsonl|appendJsonlDurable|copyFile|copyFileSync|createWriteStream)\s*\(/;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

test("no transcript.jsonl writer outside RoomHandle (regression aid, not a boundary)", async () => {
  const offenders: string[] = [];
  for (const root of ["src", "scripts"]) {
    for await (const file of walk(join(REPO, root))) {
      const rel = relative(REPO, file);
      if (ALLOWED.has(rel)) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        // A write call on the same line as a transcript path expression.
        if (!WRITE.test(line)) return;
        if (!/transcript(Path)?\b|transcript\.jsonl/.test(line)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `direct transcript writers bypass the room lock:\n${offenders.join("\n")}`);
});
