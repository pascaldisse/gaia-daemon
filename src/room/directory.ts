import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { openRoomStore, type RoomStore } from "./store.js";

/** Room-lifecycle surface of a workspace: which rooms exist, where they live,
 * and how a new room id is chosen. One room's own bytes stay with RoomStore —
 * enumeration/existence never leak into it. */
export interface RoomDirectory {
  readonly roomsDir: string;
  roomPath(roomId: string): string;
  exists(roomId: string): boolean;
  listRoomIds(): Promise<string[]>;
  open(roomId: string): RoomStore;
  /** First free `<base>-fork`, `<base>-fork-2`, … id. */
  nextForkId(base: string): string;
}

class V1FileRoomDirectory implements RoomDirectory {
  constructor(readonly roomsDir: string) {}

  // Single source of layout truth: the store already knows where a room lives.
  roomPath(roomId: string): string {
    return this.open(roomId).dir;
  }

  exists(roomId: string): boolean {
    return existsSync(this.roomPath(roomId));
  }

  async listRoomIds(): Promise<string[]> {
    if (!existsSync(this.roomsDir)) return [];
    const entries = await readdir(this.roomsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  open(roomId: string): RoomStore {
    return openRoomStore(this.roomsDir, roomId);
  }

  nextForkId(base: string): string {
    let candidate = `${base}-fork`;
    let n = 2;
    while (this.exists(candidate)) candidate = `${base}-fork-${n++}`;
    return candidate;
  }
}

/** Single factory — callers never name the backing layout. */
export function openRoomDirectory(roomsDir: string): RoomDirectory {
  return new V1FileRoomDirectory(roomsDir);
}
