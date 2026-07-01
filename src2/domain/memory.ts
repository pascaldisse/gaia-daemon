// Per-agent long-term memory: two always-injected core files plus on-demand
// topic files under the agent's memory dir.

import { existsSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ensureDir, readText, writeText } from "../core/store.js";

export type MemoryAction = "add" | "replace" | "remove";

// Always-injected core files. Everything else under the memory dir is a
// topic file, read on demand through the memory tool.
export const CORE_MEMORY_FILE = "MEMORY.md";
export const USER_MEMORY_FILE = "USER.md";

// Tight caps on the always-injected files force consolidation instead of
// letting memory grow into an unbounded junk drawer; topic files are read
// on demand, so they get a looser cap.
const FILE_LIMITS: Record<string, number> = {
  [CORE_MEMORY_FILE]: 4_000,
  [USER_MEMORY_FILE]: 2_000,
};
const TOPIC_FILE_LIMIT = 10_000;
const CONSOLIDATE_THRESHOLD = 0.8;

const DELIMITER = "§";

// Block only material that looks like an actual secret. Topical words
// ("token", "key", "print") must stay storable for a coding product; the
// room transcript, not the agent's own notes, is the injection surface.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

export interface MemoryState {
  file: string;
  path: string;
  chars: number;
  limit: number;
  usage: number;
  content: string;
}

export interface MemoryMutationResult {
  ok: boolean;
  message: string;
  state: MemoryState;
}

export interface MemoryFileInfo {
  file: string;
  chars: number;
  limit: number;
  usage: number;
}

export function memoryFileLimit(file: string): number {
  return FILE_LIMITS[file] ?? TOPIC_FILE_LIMIT;
}

/** True when `path` is `root` or contained inside it. */
function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (!existsSync(path)) await writeText(path, content);
}

// Memory files are rewritten in place; temp + rename keeps the write atomic.
async function writeTextAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeText(tmp, content);
  await rename(tmp, path);
}

export class MemoryStore {
  async init(dir: string, displayName: string): Promise<void> {
    await ensureDir(dir);
    await writeIfMissing(join(dir, CORE_MEMORY_FILE), `# ${displayName} Memory\n\n`);
    await writeIfMissing(join(dir, USER_MEMORY_FILE), `# About the User\n\n`);
  }

  async listFiles(dir: string): Promise<MemoryFileInfo[]> {
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const infos = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const path = join(entry.parentPath, entry.name);
          const file = path.slice(dir.length + 1);
          const content = (await readText(path)) ?? "";
          const limit = memoryFileLimit(file);
          return { file, chars: content.length, limit, usage: content.length / limit };
        }),
    );
    return infos.sort((a, b) => a.file.localeCompare(b.file));
  }

  async readState(dir: string, file: string): Promise<MemoryState> {
    const path = this.resolveFile(dir, file);
    const content = (await readText(path)) ?? "";
    const limit = memoryFileLimit(file);
    return { file, path, chars: content.length, limit, usage: content.length / limit, content };
  }

  async mutate(
    dir: string,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const state = await this.readState(dir, file);
    const content = (options.content ?? "").trim();
    const oldText = (options.oldText ?? "").trim();

    if ((action === "add" || action === "replace") && !content) {
      return { ok: false, message: "content is required", state };
    }
    if ((action === "replace" || action === "remove") && !oldText) {
      return { ok: false, message: "old_text is required", state };
    }
    if (content && SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      return { ok: false, message: "memory rejected: content looks like a secret (key/token/credential material)", state };
    }
    if (action !== "add" && !existsSync(state.path)) {
      return { ok: false, message: `memory file not found: ${file}`, state };
    }

    let next = state.content;
    if (action === "add") {
      if (this.entries(state.content).some((entry) => entry.trim() === content)) {
        return { ok: true, message: "duplicate memory skipped", state };
      }
      next = `${state.content.trimEnd()}\n\n${DELIMITER} ${new Date().toISOString()}\n${content}\n`;
    } else {
      const count = this.countOccurrences(state.content, oldText);
      if (count !== 1) {
        return { ok: false, message: `old_text must match exactly one memory region; matched ${count}`, state };
      }
      next =
        action === "replace"
          ? state.content.replace(oldText, content)
          : state.content.replace(oldText, "").replace(/\n{3,}/g, "\n\n");
    }

    if (next.length > state.limit) {
      return {
        ok: false,
        message: `${file} limit exceeded (${next.length}/${state.limit} chars) - consolidate existing entries or move detail into a topic file`,
        state,
      };
    }

    await ensureDir(dir);
    await writeTextAtomic(state.path, next);
    const updated = await this.readState(dir, file);
    const pressure =
      updated.usage > CONSOLIDATE_THRESHOLD
        ? ` - ${file} is at ${Math.round(updated.usage * 100)}% capacity; consolidate entries or move detail into a topic file before adding more`
        : "";
    return { ok: true, message: `${action} complete${pressure}`, state: updated };
  }

  // The block injected into the turn prompt: both core files plus a listing
  // of topic files the agent can read on demand. Callers compare the whole
  // block across turns, so any change (including a new topic file) flows to
  // the agent without a session reload.
  async promptBlock(dir: string): Promise<string> {
    const files = await this.listFiles(dir);
    const sections: string[] = [];
    for (const name of [CORE_MEMORY_FILE, USER_MEMORY_FILE]) {
      const info = files.find((item) => item.file === name);
      if (!info) continue;
      const state = await this.readState(dir, name);
      sections.push(`## ${name} (${Math.round(info.usage * 100)}% of ${info.limit} chars)\n\n${state.content.trim()}`);
    }
    const topics = files.filter((item) => item.file !== CORE_MEMORY_FILE && item.file !== USER_MEMORY_FILE);
    if (topics.length) {
      sections.push(`## Topic files (read on demand with the memory tool)\n\n${topics.map((item) => `- ${item.file}`).join("\n")}`);
    }
    return sections.join("\n\n");
  }

  // Memory file references come from the model; keep them inside the memory
  // dir and markdown-only.
  private resolveFile(dir: string, file: string): string {
    const path = resolve(dir, file);
    if (!file.endsWith(".md") || !/^[A-Za-z0-9._/-]+$/.test(file) || !pathInside(path, dir)) {
      throw new Error(`Invalid memory file name: ${file}`);
    }
    return path;
  }

  private entries(content: string): string[] {
    return content
      .split(new RegExp(`\\n${DELIMITER}[^\\n]*\\n`, "g"))
      .slice(1)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }
}
