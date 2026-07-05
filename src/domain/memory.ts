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

/** The same filter guards every memory write surface (files and facts log). */
export function looksLikeSecret(content: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

// Prompt-injection markers (MEMORY-DESIGN.md §5/§9): memory is always-injected
// context, so an entry that tries to reprogram the agent is poison, not a
// note. Deliberately tight — memory must stay able to DISCUSS injections
// ("the room had an ignore-instructions attack") without tripping; these
// match imperative phrasing only.
const INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|messages|rules|prompts)\b/i,
  /\bdisregard\s+(?:the\s+|your\s+)?(?:system\s+prompt|instructions|rules)\b/i,
  /\bdo\s+not\s+(?:tell|inform|reveal\s+(?:this\s+)?to)\s+the\s+user\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak)\s*mode\b/i,
];

/** Poison scan (write time AND snapshot build, §9). */
export function looksLikePromptInjection(content: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(content));
}

/** Why a write was rejected, or undefined when the content is storable. */
function rejectionReason(content: string): string | undefined {
  if (looksLikeSecret(content)) return "memory rejected: content looks like a secret (key/token/credential material)";
  if (looksLikePromptInjection(content)) return "memory rejected: content looks like a prompt-injection attempt (imperative override phrasing)";
  return undefined;
}

// Circuit breaker (§5): consecutive at-capacity failures on one file mean the
// agent is stuck in a consolidate-retry loop — after BREAKER_LIMIT of them
// the answer becomes terminal so a memory side-effect never eats the turn.
const BREAKER_LIMIT = 3;
const BREAKER_WINDOW_MS = 10 * 60_000;

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
  /** At-capacity failure streaks per `${dir}:${file}` (circuit breaker, §5). */
  private readonly capacityFailures = new Map<string, { count: number; last: number }>();

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
    return this.mutateBatch(dir, file, [{ action, ...options }]);
  }

  /** Atomic batch (§5): every op validates against a WORKING copy and the
   * FINAL result checks the budget once — all-or-nothing, one write, one
   * `.bak`. Ends the multi-turn consolidate-retry dance. */
  async mutateBatch(
    dir: string,
    file: string,
    operations: Array<{ action: MemoryAction; content?: string; oldText?: string }>,
  ): Promise<MemoryMutationResult> {
    const state = await this.readState(dir, file);
    if (!operations.length) return { ok: false, message: "operations are required", state };
    const breakerKey = `${dir}:${file}`;

    let next = state.content;
    let applied = 0;
    let skippedDuplicates = 0;
    let touched = false;
    for (const op of operations) {
      const content = (op.content ?? "").trim();
      const oldText = (op.oldText ?? "").trim();
      if ((op.action === "add" || op.action === "replace") && !content) {
        return { ok: false, message: "content is required", state };
      }
      if ((op.action === "replace" || op.action === "remove") && !oldText) {
        return { ok: false, message: "old_text is required", state };
      }
      const rejected = content ? rejectionReason(content) : undefined;
      if (rejected) return { ok: false, message: rejected, state };
      if (op.action !== "add" && !existsSync(state.path)) {
        return { ok: false, message: `memory file not found: ${file}`, state };
      }

      if (op.action === "add") {
        if (this.entries(next).some((entry) => entry.trim() === content)) {
          skippedDuplicates += 1;
          continue;
        }
        next = `${next.trimEnd()}\n\n${DELIMITER} ${new Date().toISOString()}\n${content}\n`;
      } else {
        const count = this.countOccurrences(next, oldText);
        if (count !== 1) {
          // Drift (§5): the region the caller last saw is gone or ambiguous —
          // likely edited out-of-band. Nothing was written; say to re-read.
          return {
            ok: false,
            message: `old_text must match exactly one memory region; matched ${count}${count === 0 ? " — the file may have changed since you read it; re-read it and retry" : ""}`,
            state,
          };
        }
        next = op.action === "replace" ? next.replace(oldText, content) : next.replace(oldText, "").replace(/\n{3,}/g, "\n\n");
        touched = true;
      }
      applied += 1;
    }

    if (applied === 0) {
      return { ok: true, message: `duplicate memory skipped (${skippedDuplicates})`, state };
    }

    if (next.length > state.limit) {
      // Circuit breaker (§5): count the at-capacity streak; from the Nth
      // failure on, the answer is terminal — STOP retrying, answer the user.
      // A write that FITS (a shrinking consolidation batch) always proceeds:
      // the breaker ends the retry loop, it never locks the escape hatch.
      const now = Date.now();
      const streak = this.capacityFailures.get(breakerKey);
      const failures = streak && now - streak.last < BREAKER_WINDOW_MS ? streak.count + 1 : 1;
      this.capacityFailures.set(breakerKey, { count: failures, last: now });
      if (failures > BREAKER_LIMIT) {
        return {
          ok: false,
          message: `memory circuit breaker: ${failures} consecutive at-capacity writes to ${file} — STOP writing memory and answer the user; consolidate with ONE batch (remove/replace + add) or in a later turn`,
          state,
        };
      }
      const terminal =
        failures === BREAKER_LIMIT
          ? ` — memory circuit breaker armed after ${failures} at-capacity attempts: STOP writing memory and answer the user`
          : "";
      return {
        ok: false,
        message: `${file} limit exceeded (${next.length}/${state.limit} chars) - consolidate existing entries or move detail into a topic file${terminal}`,
        state,
      };
    }

    await ensureDir(dir);
    // Destructive edits snapshot the prior content first — one .bak per file,
    // overwritten each time, never listed or injected (not a .md).
    if (touched && state.content) await writeTextAtomic(`${state.path}.bak`, state.content);
    await writeTextAtomic(state.path, next);
    this.capacityFailures.delete(breakerKey);
    const updated = await this.readState(dir, file);
    const pressure =
      updated.usage > CONSOLIDATE_THRESHOLD
        ? ` - ${file} is at ${Math.round(updated.usage * 100)}% capacity; consolidate entries or move detail into a topic file before adding more`
        : "";
    const summary = operations.length === 1 ? `${operations[0].action} complete` : `batch complete: ${applied} applied${skippedDuplicates ? `, ${skippedDuplicates} duplicates skipped` : ""}`;
    return { ok: true, message: `${summary}${pressure}`, state: updated };
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
      sections.push(`## ${name} (${Math.round(info.usage * 100)}% of ${info.limit} chars)\n\n${this.scrubForSnapshot(state.content, name).trim()}`);
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

  /** Snapshot-time poison scan (§9): flagged entries render as [BLOCKED: …]
   * in the injected block while the on-disk text stays intact and
   * user-reviewable. Deterministic from disk bytes; the write scan catches new
   * poison, this catches what predates it (or slipped past). */
  private scrubForSnapshot(content: string, file: string): string {
    const segments = content.split(new RegExp(`(\\n${DELIMITER}[^\\n]*\\n)`, "g"));
    // segments = [preamble, delimiter, entry, delimiter, entry, …]
    for (let i = 2; i < segments.length; i += 2) {
      if (looksLikePromptInjection(segments[i])) {
        segments[i] = `[BLOCKED: flagged entry — review ${file} in the memory dir]\n`;
      }
    }
    // A poisoned preamble (no delimiter) blocks wholesale — never inject it.
    if (segments.length && looksLikePromptInjection(segments[0])) {
      segments[0] = `[BLOCKED: flagged content — review ${file} in the memory dir]\n`;
    }
    return segments.join("");
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
