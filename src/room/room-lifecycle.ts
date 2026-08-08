import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { openRoomStore } from "./store.js";

/** Room enumeration / existence for a workspace's rooms dir.
 * Lives here, not on RoomStore: a store is ONE room's storage; the set of
 * rooms is a layout question and belongs to the room layer as a whole.
 * Callers above (controller/UI) never touch fs for room discovery. */

export interface RoomRecord {
  id: string;
  path: string;
  // Set on a summon's child room: the room that spawned it. Read from the
  // room's own state so the sidebar can nest it under its parent.
  parentRoomId?: string;
}

/** Room ids present on disk, sorted. Missing rooms dir → []. */
export async function listRoomIds(roomsDir: string): Promise<string[]> {
  if (!existsSync(roomsDir)) return [];
  const entries = await readdir(roomsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function roomExists(roomsDir: string, roomId: string): boolean {
  return existsSync(openRoomStore(roomsDir, roomId).dir);
}

/** Every room with its layout path and parent link. Never throws on a
 * malformed state.json — readRoomState normalizes unreadable state to
 * defaults, so a broken room still lists. */
export async function listRooms(roomsDir: string): Promise<RoomRecord[]> {
  const ids = await listRoomIds(roomsDir);
  return Promise.all(
    ids.map(async (id) => {
      const store = openRoomStore(roomsDir, id);
      const state = await store.readState();
      return {
        id,
        path: store.dir,
        ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
      };
    }),
  );
}

/** Path of a room without leaking the layout to callers. */
export function roomPath(roomsDir: string, roomId: string): string {
  return openRoomStore(roomsDir, roomId).dir;
}

/** First free `<base>-fork`, `<base>-fork-2`, `<base>-fork-3`… id.
 * Check-then-create is not atomic; forks are user-driven and serialized per
 * controller, so the race is accepted rather than locked. */
export function nextForkId(roomsDir: string, base: string): string {
  let candidate = `${base}-fork`;
  let n = 2;
  while (roomExists(roomsDir, candidate)) candidate = `${base}-fork-${n++}`;
  return candidate;
}
