import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { jsonText } from "../lib/fs.js";
import {
  defaultRoomState,
  readRoomState,
  readRoomStateCompatibility,
  roomStatePath,
  updateRoomState,
  writeRoomState,
  type RoomState,
  type RoomStateCompatibility,
} from "./state.js";
import {
  appendRoomEvent,
  readRecentRoomEvents,
  readRoomEventsAfterCursor,
  type RoomEvent,
} from "./transcript.js";

export interface RoomStore {
  readonly dir: string;
  readonly transcriptPath: string;
  readonly statePath: string;

  /** Create missing room files with defaults. Never touches existing bytes. */
  initialize(): Promise<void>;
  clearTranscript(): Promise<void>;
  copyTranscriptTo(destination: RoomStore): Promise<void>;
  appendEvent(event: RoomEvent): Promise<void>;
  hasEvent(eventId: string): Promise<boolean>;
  recentEvents(limit: number): Promise<RoomEvent[]>;
  eventsAfterCursor(cursor: number): Promise<{ events: RoomEvent[]; nextCursor: number }>;
  readState(): Promise<RoomState>;
  stateCompatibility(): Promise<RoomStateCompatibility>;
  writeState(state: RoomState): Promise<void>;
  /** Serialize read-modify-write mutations for this room store instance. */
  updateState(mutate: (state: RoomState) => void | RoomState | Promise<void | RoomState>): Promise<RoomState>;
}

/** Exclusive create: concurrent initializers never truncate an existing file. */
async function createIfMissing(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Direct adapter for the existing v1 room layout. Opening a room never
 * rewrites it: state.json and transcript.jsonl remain the authority. */
export class V1FileRoomStore implements RoomStore {
  readonly dir: string;
  readonly transcriptPath: string;
  readonly statePath: string;
  private stateUpdates: Promise<void> = Promise.resolve();

  constructor(roomsDir: string, roomId: string) {
    this.dir = join(roomsDir, roomId);
    this.transcriptPath = join(this.dir, "transcript.jsonl");
    this.statePath = roomStatePath(roomsDir, roomId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await createIfMissing(this.transcriptPath, "");
    await createIfMissing(this.statePath, jsonText(defaultRoomState()));
  }

  async clearTranscript(): Promise<void> {
    await mkdir(dirname(this.transcriptPath), { recursive: true });
    await writeFile(this.transcriptPath, "", "utf8");
  }

  async copyTranscriptTo(destination: RoomStore): Promise<void> {
    await mkdir(destination.dir, { recursive: true });
    try {
      await copyFile(this.transcriptPath, destination.transcriptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async appendEvent(event: RoomEvent): Promise<void> {
    await appendRoomEvent(this.transcriptPath, event);
  }

  async hasEvent(eventId: string): Promise<boolean> {
    const { events } = await readRoomEventsAfterCursor(this.transcriptPath, 0);
    return events.some((event) => event.id === eventId);
  }

  async recentEvents(limit: number): Promise<RoomEvent[]> {
    return readRecentRoomEvents(this.transcriptPath, limit);
  }

  async eventsAfterCursor(cursor: number): Promise<{ events: RoomEvent[]; nextCursor: number }> {
    return readRoomEventsAfterCursor(this.transcriptPath, cursor);
  }

  async readState(): Promise<RoomState> {
    return readRoomState(this.statePath);
  }

  async stateCompatibility(): Promise<RoomStateCompatibility> {
    return readRoomStateCompatibility(this.statePath);
  }

  async writeState(state: RoomState): Promise<void> {
    await writeRoomState(this.statePath, state);
  }

  updateState(mutate: (state: RoomState) => void | RoomState | Promise<void | RoomState>): Promise<RoomState> {
    const run = async (): Promise<RoomState> => {
      const state = await this.readState();
      const before = structuredClone(state);
      const next = (await mutate(state)) ?? state;
      if (!isDeepStrictEqual(before, next)) await updateRoomState(this.statePath, before, next);
      return next;
    };
    const update = this.stateUpdates.then(run, run);
    this.stateUpdates = update.then(() => undefined, () => undefined);
    return update;
  }
}

/** Adapter seam. Composition owns the backing layout; callers depend on this port. */
export type RoomStoreFactory = (roomsDir: string, roomId: string) => RoomStore;

/** v1 composition point. Keep adapter selection here, never at callers. */
export const v1RoomStoreFactory: RoomStoreFactory = (roomsDir, roomId) => new V1FileRoomStore(roomsDir, roomId);

/** Legacy-friendly v1 entry point. New composition passes RoomStoreFactory explicitly. */
export function openRoomStore(roomsDir: string, roomId: string): RoomStore {
  return v1RoomStoreFactory(roomsDir, roomId);
}
