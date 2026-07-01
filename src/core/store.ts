// The only module that touches the filesystem for state. Atomic JSON writes
// (temp file + rename on the same volume), JSONL append/scan, and dir helpers.

import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write-then-rename so readers never observe a torn file, fsynced so a crash
 * right after the call cannot lose the payload. This is what makes "one atomic
 * state write" in the WAL protocol true. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${process.pid}.${Date.now().toString(36)}.tmp`);
  await writeFile(tmp, jsonText(value), "utf8");
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await rename(tmp, path);
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export interface JsonlPage<T> {
  items: T[];
  /** Line count after the read — the next cursor. */
  nextCursor: number;
}

/** Read JSONL entries from a line cursor. Unparseable lines are skipped but
 * still counted, so cursors stay stable across readers. The parse callback
 * receives the absolute line index (cursor-relative position + cursor). */
export async function readJsonlFrom<T>(path: string, cursor: number, parse: (raw: unknown, lineIndex: number) => T | undefined): Promise<JsonlPage<T>> {
  if (!existsSync(path)) return { items: [], nextCursor: 0 };
  const text = await readFile(path, "utf8");
  if (!text.trim()) return { items: [], nextCursor: 0 };
  const lines = text.split("\n").filter((line) => line.trim());
  const start = Math.max(0, Math.floor(cursor));
  const items: T[] = [];
  lines.slice(start).forEach((line, offset) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const item = parse(raw, start + offset);
    if (item !== undefined) items.push(item);
  });
  return { items, nextCursor: lines.length };
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}
