import { existsSync, type Dirent } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { openRoomStore, type RoomStore } from "../room/store.js";

/** Workspace-scoped room lifecycle. RoomStore remains the port for one room's
 * bytes; discovery and reservation belong to the room collection. */
export interface RoomRecord {
  id: string;
  path: string;
  parentRoomId?: string;
}

export interface ReservedRoom {
  id: string;
  store: RoomStore;
}

export interface RoomLifecycle {
  readonly roomsDir: string;
  roomPath(roomId: string): string;
  exists(roomId: string): boolean;
  /** Includes currentRoomId when its directory has not been created yet. */
  list(currentRoomId?: string): Promise<RoomRecord[]>;
  open(roomId: string): RoomStore;
  /** Create the room's files when missing; existing bytes are never touched. */
  ensure(roomId: string): Promise<RoomStore>;
  /** Atomically reserve the first available `<base>-fork[-N]` directory. */
  reserveFork(base: string): Promise<ReservedRoom>;
}

class V1FileRoomLifecycle implements RoomLifecycle {
  constructor(readonly roomsDir: string) {}

  roomPath(roomId: string): string {
    return this.open(roomId).dir;
  }

  exists(roomId: string): boolean {
    return existsSync(this.roomPath(roomId));
  }

  async list(currentRoomId?: string): Promise<RoomRecord[]> {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(this.roomsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (currentRoomId && !ids.includes(currentRoomId)) ids.push(currentRoomId);
    ids.sort((a, b) => a.localeCompare(b));
    return Promise.all(ids.map(async (id) => {
      const store = this.open(id);
      const state = await store.readState();
      return { id, path: store.dir, ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}) };
    }));
  }

  open(roomId: string): RoomStore {
    return openRoomStore(this.roomsDir, roomId);
  }

  async ensure(roomId: string): Promise<RoomStore> {
    const store = this.open(roomId);
    await store.initialize();
    return store;
  }

  async reserveFork(base: string): Promise<ReservedRoom> {
    await mkdir(this.roomsDir, { recursive: true });
    for (let suffix = 1; ; suffix += 1) {
      const id = suffix === 1 ? `${base}-fork` : `${base}-fork-${suffix}`;
      const store = this.open(id);
      try {
        await mkdir(store.dir);
        return { id, store };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}

/** Single factory — callers never name the backing layout. */
export function openRoomLifecycle(roomsDir: string): RoomLifecycle {
  return new V1FileRoomLifecycle(roomsDir);
}
