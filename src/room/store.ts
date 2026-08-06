import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readRoomState, roomStatePath, writeRoomState, type RoomState } from "./state.js";
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

  clearTranscript(): Promise<void>;
  copyTranscriptTo(destination: RoomStore): Promise<void>;
  appendEvent(event: RoomEvent): Promise<void>;
  recentEvents(limit: number): Promise<RoomEvent[]>;
  eventsAfterCursor(cursor: number): Promise<{ events: RoomEvent[]; nextCursor: number }>;
  readState(): Promise<RoomState>;
  writeState(state: RoomState): Promise<void>;
}

/** Direct adapter for the existing v1 room layout. Opening a room never
 * rewrites it: state.json and transcript.jsonl remain the authority. */
export class V1FileRoomStore implements RoomStore {
  readonly dir: string;
  readonly transcriptPath: string;
  readonly statePath: string;

  constructor(roomsDir: string, roomId: string) {
    this.dir = join(roomsDir, roomId);
    this.transcriptPath = join(this.dir, "transcript.jsonl");
    this.statePath = roomStatePath(roomsDir, roomId);
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

  async recentEvents(limit: number): Promise<RoomEvent[]> {
    return readRecentRoomEvents(this.transcriptPath, limit);
  }

  async eventsAfterCursor(cursor: number): Promise<{ events: RoomEvent[]; nextCursor: number }> {
    return readRoomEventsAfterCursor(this.transcriptPath, cursor);
  }

  async readState(): Promise<RoomState> {
    return readRoomState(this.statePath);
  }

  async writeState(state: RoomState): Promise<void> {
    await writeRoomState(this.statePath, state);
  }
}

/** Single factory for room stores. Callers never name the backing layout. */
export function openRoomStore(roomsDir: string, roomId: string): RoomStore {
  return new V1FileRoomStore(roomsDir, roomId);
}
