// node:sqlite vs bun:sqlite — the only runtime fork in the codebase; both are
// the platform's built-in sqlite, zero deps. Every other module imports the
// `SqliteDatabase` type and calls `openSqlite()` from here instead of
// touching either runtime's module directly, so the fork stays in one place.

import { createRequire } from "node:module";

/** A prepared statement — the exact subset of node:sqlite's StatementSync /
 * bun:sqlite's Statement that this codebase uses. */
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
}

/** A sqlite handle — the exact subset of node:sqlite's DatabaseSync /
 * bun:sqlite's Database that this codebase uses. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// Declared ambiently by Bun's own types when they're in scope; guarded with
// `typeof` so this file also type-checks under plain @types/node.
declare const Bun: unknown;

// `require`, not `import` — node:sqlite doesn't exist under Bun and bun:sqlite
// doesn't exist under Node, so resolving the wrong one at import time would
// crash the OTHER runtime before this function ever runs. A non-static
// require defers resolution to whichever runtime is actually executing.
const req = createRequire(import.meta.url);

/** Open (creating if needed) the platform's built-in sqlite database at
 * `path`: bun:sqlite's `Database` under Bun, node:sqlite's `DatabaseSync`
 * under Node. Both classes already match `SqliteDatabase`'s surface 1:1
 * (.exec, .prepare, .close; statements' .all/.get/.run), so no wrapping is
 * needed — just picking the right constructor. */
export function openSqlite(path: string): SqliteDatabase {
  if (typeof Bun !== "undefined") {
    const { Database } = req("bun:sqlite") as { Database: new (path: string) => SqliteDatabase };
    return new Database(path);
  }
  const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new DatabaseSync(path);
}

export interface SqliteLockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

/** Process-wide exclusion backed by SQLite's OS file locks. This coordinates
 * only processes sharing one local filesystem; network filesystem semantics
 * are intentionally outside this guarantee. A killed owner releases its
 * SQLite transaction lock with the process. */
/** Release the lock transaction. The coordination database carries NO rows —
 * the protected work happened in the filesystem — so a failed COMMIT loses
 * nothing and must never surface as a caller error (the work already
 * succeeded) nor trigger a re-run (the work is not idempotent). Closing the
 * handle releases the OS lock either way. */
async function commitSqlite(db: SqliteDatabase, deadline: number, retryMs: number): Promise<void> {
  while (true) {
    try {
      db.exec("COMMIT");
      return;
    } catch (error) {
      if (!/\b(busy|locked)\b/i.test(String(error)) || Date.now() >= deadline) return;
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function withSqliteImmediateLock<T>(path: string, work: () => Promise<T>, options: SqliteLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // Deadline is checked BEFORE acquiring: a caller past its budget runs the
    // callback zero times rather than once, late.
    if (Date.now() >= deadline) throw new Error(`SQLite lock contention timed out after ${timeoutMs}ms: ${path}`);
    const db = openSqlite(path);
    let began = false;
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = await work();
      await commitSqlite(db, deadline, retryMs);
      return result;
    } catch (error) {
      if (began) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      }
      const busy = /\b(busy|locked)\b/i.test(String(error));
      if (began || !busy || Date.now() >= deadline) {
        if (busy && !began) throw new Error(`SQLite lock contention timed out after ${timeoutMs}ms: ${String(error)}`, { cause: error });
        throw error;
      }
    } finally {
      db.close();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}
