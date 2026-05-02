import { join } from "node:path";
import type { Workspace } from "../workspace/types.js";
import { readRoomState, roomStatePath, writeRoomState, type RoomState } from "./state.js";
import { appendRoomEvent, countRoomEventLines, readRecentRoomEvents, readRoomEventsAfterCursor, type RoomEvent } from "./transcript.js";

export class Room {
  readonly id: string;
  readonly transcriptPath: string;
  readonly statePath: string;

  constructor(private readonly workspace: Workspace) {
    this.id = workspace.config.room;
    this.transcriptPath = join(workspace.roomsDir, this.id, "transcript.jsonl");
    this.statePath = roomStatePath(workspace.roomsDir, this.id);
  }

  async addUserMessage(text: string, targets: string[]): Promise<void> {
    await appendRoomEvent(this.transcriptPath, {
      timestamp: new Date().toISOString(),
      author: "user",
      targets,
      text,
    });
  }

  async addAgentMessage(author: string, text: string): Promise<void> {
    await appendRoomEvent(this.transcriptPath, {
      timestamp: new Date().toISOString(),
      author,
      text,
    });
  }

  async recentEvents(): Promise<RoomEvent[]> {
    return readRecentRoomEvents(this.transcriptPath, this.workspace.config.transcriptWindow);
  }

  async eventsAfterCursor(cursor: number): Promise<{ events: RoomEvent[]; nextCursor: number }> {
    return readRoomEventsAfterCursor(this.transcriptPath, cursor);
  }

  async eventCursor(): Promise<number> {
    return countRoomEventLines(this.transcriptPath);
  }

  async readState(): Promise<RoomState> {
    return readRoomState(this.statePath);
  }

  async writeState(state: RoomState): Promise<void> {
    await writeRoomState(this.statePath, state);
  }
}

export function renderRoomTranscript(events: RoomEvent[]): string {
  if (events.length === 0) return "(empty room)";

  return events
    .map((event) => {
      const header =
        "targets" in event
          ? `user -> ${event.targets.map((target: string) => `@${target}`).join(", ")}`
          : `@${event.author}`;
      return `[${event.timestamp}] ${header}:\n${event.text}`;
    })
    .join("\n\n");
}
