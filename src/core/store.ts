// The only module that touches the filesystem for state. Atomic JSON writes
// (temp file + rename on the same volume), JSONL append/scan, and dir helpers.

import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
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

/** Per-process tmp-name uniquifier: pid + timestamp alone COLLIDE when two
 * atomic writes land in the same directory in the same millisecond (e.g. a
 * room's state.json vs its sanitize.json) — one rename then steals or drops
 * the other's tmp file. The counter makes every tmp name unique. */
let tmpSeq = 0;

/** Write-then-rename so readers never observe a torn file, fsynced so a crash
 * right after the call cannot lose the payload. This is what makes "one atomic
 * state write" in the WAL protocol true. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${process.pid}.${(tmpSeq++).toString(36)}.${Date.now().toString(36)}.tmp`);
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

/** Append one JSONL record and fsync before returning — for logs whose caller
 * publishes a durable decision about them afterwards (the WAL: the transcript
 * line must survive a power cut that the following state write also survives,
 * or resume would replay a turn as if it had never committed).
 *
 * A file whose last byte is not a newline is left EXACTLY as it is except for
 * one inserted separator newline: the tail may be a valid legacy line written
 * without a terminator, or torn bytes from a pre-fsync crash. Either way it is
 * committed history — never repaired, never truncated — but the new record
 * must not be glued onto it, which would corrupt a good line or hide the
 * damaged one. Separator and record go out in ONE write: two writes let a
 * concurrent O_APPEND writer land between them, which injects blank lines and
 * breaks the "1 event = 1 JSON line" contract every cursor is counted in. */
export async function appendJsonlDurable(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const handle = await open(path, "a+");
  try {
    const { size } = await handle.stat();
    let prefix = "";
    if (size > 0) {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail[0] !== 0x0a) prefix = "\n";
    }
    await handle.write(`${prefix}${JSON.stringify(value)}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Append MANY JSONL records with ONE write and ONE fsync — same durability
 * contract and same separator-newline handling as appendJsonlDurable, but the
 * cost is O(1) syncs instead of O(n). Archiving a rewrite's dropped events is
 * done under the room lock, so a per-event fsync makes lock hold time grow
 * linearly with history (5k events ≈ 0.9s, 30k ≈ the sqlite lock timeout) and
 * concurrent appends start failing. Records are chunked only to bound memory;
 * the single sync happens after the last chunk, which is what makes the whole
 * batch durable before the caller publishes its rewrite. */
export async function appendJsonlBatchDurable(path: string, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) return;
  await ensureDir(dirname(path));
  const handle = await open(path, "a+");
  try {
    const { size } = await handle.stat();
    let pending = "";
    if (size > 0) {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail[0] !== 0x0a) pending = "\n";
    }
    for (const value of values) {
      pending += `${JSON.stringify(value)}\n`;
      if (pending.length >= 1 << 20) {
        await handle.write(pending, null, "utf8");
        pending = "";
      }
    }
    if (pending.length > 0) await handle.write(pending, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Atomic full-file text write (tmp + fsync + rename) — for the rare case a
 * normally append-only log must be rewritten (e.g. purging a deleted room's
 * episodes) without risking a torn file. */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${process.pid}.${(tmpSeq++).toString(36)}.${Date.now().toString(36)}.tmp`);
  await writeFile(tmp, content, "utf8");
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await rename(tmp, path);
}

/** Atomic full-file binary write for room-owned payloads. */
export async function writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${process.pid}.${(tmpSeq++).toString(36)}.${Date.now().toString(36)}.tmp`);
  await writeFile(tmp, content);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await rename(tmp, path);
}

export async function appendText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, content, "utf8");
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

/** Create-if-missing, exclusively: the ONLY sanctioned way to seed a file that
 * must never clobber bytes it does not own. `existsSync` + write is a TOCTOU —
 * every concurrent seeder observes the gap and writes. `wx` lets the kernel
 * pick one winner; every loser sees EEXIST and is a no-op. Returns whether
 * THIS call created the file (first-winner semantics for callers that seed
 * initial content). */
export async function writeTextIfMissing(path: string, content: string): Promise<boolean> {
  await ensureDir(dirname(path));
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}
