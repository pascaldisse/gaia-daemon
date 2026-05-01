import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type MemoryAction = "add" | "replace" | "remove";

export interface MemoryState {
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

const DEFAULT_LIMIT = 12_000;
const DELIMITER = "§";
const UNSAFE_PATTERNS = [
  /ignore (all )?(previous|prior) instructions/i,
  /reveal|print|dump|exfiltrate/i,
  /system prompt|developer message|hidden instruction/i,
  /api[_ -]?key|access token|password|credential|private key|ssh key/i,
];

export class MemoryStore {
  constructor(private readonly defaultLimit = DEFAULT_LIMIT) {}

  async init(path: string, title = "Memory"): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!existsSync(path)) await writeFile(path, `# ${title}\n\n`, "utf8");
  }

  async readState(path: string, limit = this.defaultLimit): Promise<MemoryState> {
    const content = existsSync(path) ? await readFile(path, "utf8") : "";
    return {
      path,
      chars: content.length,
      limit,
      usage: limit === 0 ? 0 : content.length / limit,
      content,
    };
  }

  async mutate(
    path: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
    limit = this.defaultLimit,
  ): Promise<MemoryMutationResult> {
    const state = await this.readState(path, limit);
    const content = (options.content ?? "").trim();
    const oldText = (options.oldText ?? "").trim();

    if ((action === "add" || action === "replace") && !content) {
      return { ok: false, message: "content is required", state };
    }
    if ((action === "replace" || action === "remove") && !oldText) {
      return { ok: false, message: "old_text is required", state };
    }
    if (content && this.isUnsafe(content)) {
      return { ok: false, message: "memory rejected: unsafe prompt-injection or secret pattern", state };
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
      return { ok: false, message: `memory limit exceeded (${next.length}/${state.limit} chars)`, state };
    }

    await this.writeAtomic(path, next);
    const updated = await this.readState(path, limit);
    return { ok: true, message: `${action} complete`, state: updated };
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

  private isUnsafe(content: string): boolean {
    return UNSAFE_PATTERNS.some((pattern) => pattern.test(content));
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  }
}
