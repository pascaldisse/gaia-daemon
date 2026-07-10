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
