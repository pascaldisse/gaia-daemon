import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ContextFile } from "./types.js";

function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);

  while (true) {
    dirs.unshift(current);
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

export async function discoverContextFiles(cwd: string): Promise<ContextFile[]> {
  const files: ContextFile[] = [];

  for (const dir of ancestorDirs(cwd)) {
    const path = join(dir, "AGENTS.md");
    if (!existsSync(path)) continue;
    files.push({ path, content: await readFile(path, "utf8") });
  }

  return files;
}
