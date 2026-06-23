import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Workspace } from "../workspace/types.js";
import { readRoomState, roomStatePath, writeRoomState, type RoomState } from "./state.js";
import { appendRoomEvent, newRoomEventId, readRecentRoomEvents, readRoomEventsAfterCursor, type AgentRoomEvent, type RoomEvent, type UserRoomEvent } from "./transcript.js";

export class Room {
  readonly id: string;
  readonly dir: string;
  readonly transcriptPath: string;
  readonly statePath: string;

  constructor(private readonly workspace: Workspace) {
    this.id = workspace.config.room;
    this.dir = join(workspace.roomsDir, this.id);
    this.transcriptPath = join(workspace.roomsDir, this.id, "transcript.jsonl");
    this.statePath = roomStatePath(workspace.roomsDir, this.id);
  }

  // Wipe the room transcript (backs /clear). Leaves the file present-but-empty
  // so readers see a clean room.
  async clearTranscript(): Promise<void> {
    await mkdir(dirname(this.transcriptPath), { recursive: true });
    await writeFile(this.transcriptPath, "", "utf8");
  }

  async addUserMessage(text: string, targets: string[], channel?: string): Promise<UserRoomEvent> {
    const event: UserRoomEvent = {
      id: newRoomEventId(),
      timestamp: new Date().toISOString(),
      author: "user",
      targets,
      text,
      ...(channel ? { channel } : {}),
    };
    await appendRoomEvent(this.transcriptPath, event);
    return event;
  }

  async addAgentMessage(author: string, text: string, channel?: string): Promise<AgentRoomEvent> {
    const event: AgentRoomEvent = {
      id: newRoomEventId(),
      timestamp: new Date().toISOString(),
      author,
      text,
      ...(channel ? { channel } : {}),
    };
    await appendRoomEvent(this.transcriptPath, event);
    return event;
  }

  async recentEvents(): Promise<RoomEvent[]> {
    return readRecentRoomEvents(this.transcriptPath, this.workspace.config.transcriptWindow);
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
