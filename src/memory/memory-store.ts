import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersonaId } from "../personas/types.js";
import { PERSONAS } from "../personas/types.js";

export type MemoryTarget = "user" | "persona";
export type MemoryAction = "add" | "replace" | "remove";

export interface MemoryLimits {
  user: number;
  persona: number;
}

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

const DELIMITER = "§";
const UNSAFE_PATTERNS = [
  /ignore (all )?(previous|prior) instructions/i,
  /reveal|print|dump|exfiltrate/i,
  /system prompt|developer message|hidden instruction/i,
  /api[_ -]?key|access token|password|credential|private key|ssh key/i,
];

export class MemoryStore {
  constructor(
    public readonly dir: string,
    private readonly limits: MemoryLimits,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const file of ["USER.md", "GAIA.md", "SIDIA.md"]) {
      const path = join(this.dir, file);
      if (!existsSync(path)) await writeFile(path, `# ${file}\n\n`, "utf8");
    }
  }

  fileFor(target: MemoryTarget, persona: PersonaId): string {
    if (target === "user") return join(this.dir, "USER.md");
    const memoryFile = PERSONAS[persona].memoryFile;
    if (!memoryFile) return join(this.dir, "USER.md");
    return join(this.dir, memoryFile);
  }

  limitFor(target: MemoryTarget): number {
    return target === "user" ? this.limits.user : this.limits.persona;
  }

  async readState(target: MemoryTarget, persona: PersonaId): Promise<MemoryState> {
    const path = this.fileFor(target, persona);
    const limit = this.limitFor(target);
    const content = existsSync(path) ? await readFile(path, "utf8") : "";
    return { path, chars: content.length, limit, usage: limit === 0 ? 0 : content.length / limit, content };
  }

  async snapshot(persona: PersonaId): Promise<{ user: MemoryState; persona?: MemoryState }> {
    const user = await this.readState("user", persona);
    const personaState = PERSONAS[persona].memoryFile ? await this.readState("persona", persona) : undefined;
    return { user, persona: personaState };
  }

  async mutate(
    persona: PersonaId,
    target: MemoryTarget,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    const state = await this.readState(target, persona);
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
      next = action === "replace" ? state.content.replace(oldText, content) : state.content.replace(oldText, "").replace(/\n{3,}/g, "\n\n");
    }

    if (next.length > state.limit) {
      return { ok: false, message: `memory limit exceeded (${next.length}/${state.limit} chars)`, state };
    }

    await this.writeAtomic(state.path, next);
    const updated = await this.readState(target, persona);
    return { ok: true, message: `${basename(state.path)} ${action} complete`, state: updated };
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
      count++;
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
