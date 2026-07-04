// One session tracker for every harness. v1 grew three hand-rolled copies of
// this (Claude's RoomState, Pi's ManagedPiSession, Codex's ThreadState), each
// re-implementing the per-room map and the "send memory only when it changed"
// diff. A harness supplies only its metadata type M and an optional disposer.
//
// Persistence (optional): a harness whose session handle is a serializable
// value (codex threadId, claude sessionId) passes a SessionStore and its
// sessions survive daemon/runner restarts — the next process resumes the same
// underlying conversation instead of silently starting a fresh one. reset()
// is /clear semantics (forget everywhere); disposeAll() is teardown (persisted
// handles survive). Pi persists its own sessions on disk and passes no store.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "../core/paths.js";

export interface SessionStore<M> {
  load(roomId: string): M | undefined;
  save(roomId: string, meta: M): void;
  clear(roomId: string): void;
}

export class SessionMap<M> {
  private sessions = new Map<string, M>();
  private lastMemory = new Map<string, string>();

  constructor(
    private readonly disposeMeta?: (meta: M) => void,
    private readonly store?: SessionStore<M>,
  ) {}

  get(roomId: string): M | undefined {
    const existing = this.sessions.get(roomId);
    if (existing !== undefined) return existing;
    const loaded = this.store?.load(roomId);
    if (loaded !== undefined) this.sessions.set(roomId, loaded);
    return loaded;
  }

  ensure(roomId: string, create: () => M): M {
    const existing = this.get(roomId);
    if (existing !== undefined) return existing;
    const meta = create();
    this.set(roomId, meta);
    return meta;
  }

  set(roomId: string, meta: M): void {
    this.sessions.set(roomId, meta);
    this.store?.save(roomId, meta);
  }

  /** True when `memory` differs from what this room last sent; records it.
   * Backs the "memory travels in the turn prompt only when it changed" rule.
   * The diff dies with the session (reset ⇒ next turn resends memory). */
  memoryChanged(roomId: string, memory: string): boolean {
    if (this.lastMemory.get(roomId) === memory) return false;
    this.lastMemory.set(roomId, memory);
    return true;
  }

  /** Forget a room's session everywhere — memory AND store (/clear). */
  reset(roomId: string): void {
    const meta = this.sessions.get(roomId);
    if (meta !== undefined) this.disposeMeta?.(meta);
    this.sessions.delete(roomId);
    this.lastMemory.delete(roomId);
    this.store?.clear(roomId);
  }

  /** Tear down in-memory state only. Persisted session handles survive so the
   * next process can resume the same conversation (dispose ≠ forget). */
  disposeAll(): void {
    for (const meta of this.sessions.values()) this.disposeMeta?.(meta);
    this.sessions.clear();
    this.lastMemory.clear();
  }

  rooms(): string[] {
    return [...this.sessions.keys()];
  }
}

/** Durable per-room session handles: .gaia/rooms/<room>/harness-sessions.json,
 * one key per (agent, harness). Two agents of the SAME harness in one room must
 * NOT share a session — each keeps its own conversation — so the key carries the
 * agent id, not just the harness. Best-effort: a read/write failure just means
 * the session starts fresh, exactly the pre-persistence behavior.
 *
 * Legacy: rooms written before agent-scoping stored a bare `<harness>` key. It
 * is read once as a fallback so an existing room keeps its session (losing it
 * would drop pre-cursor history), then dropped on the next save. */
export function fileSessionStore<M>(rootDir: string, harnessId: string, agentId: string): SessionStore<M> {
  const key = `${harnessId}:${agentId}`;
  const legacyKey = harnessId;
  const fileFor = (roomId: string): string => join(workspacePaths.roomDir(rootDir, roomId), "harness-sessions.json");
  const readAll = (roomId: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(fileFor(roomId), "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const writeAll = (roomId: string, all: Record<string, unknown>): void => {
    const path = fileFor(roomId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
  };
  return {
    load(roomId) {
      const all = readAll(roomId);
      // Agent-scoped key wins; fall back to the legacy bare-harness entry once
      // (only recovers a single-agent room — a multi-agent room's bare key was
      // already ambiguous, and each agent diverges to its own key on save).
      const meta = key in all ? all[key] : all[legacyKey];
      return meta === undefined ? undefined : (meta as M);
    },
    save(roomId, meta) {
      try {
        const all = readAll(roomId);
        delete all[legacyKey]; // migrate: the ambiguous bare key is superseded
        writeAll(roomId, { ...all, [key]: meta });
      } catch {
        // Best-effort: an unsaved handle only costs resume-after-restart.
      }
    },
    clear(roomId) {
      try {
        const all = readAll(roomId);
        if (!(key in all) && !(legacyKey in all)) return;
        delete all[key];
        delete all[legacyKey];
        writeAll(roomId, all);
      } catch {
        // Best-effort.
      }
    },
  };
}
