import type { Workspace } from "../workspace/types.js";
import { type RoomState } from "./state.js";
import { V1FileRoomStore, type RoomStore } from "./store.js";
import { newRoomEventId, type AgentRoomEvent, type RoomEvent, type UserRoomEvent } from "./transcript.js";

export class Room {
  readonly id: string;
  readonly dir: string;
  readonly transcriptPath: string;
  readonly statePath: string;
  private readonly store: RoomStore;

  // roomId defaults to the workspace's configured room; pass an explicit id to
  // address any other room in the workspace (e.g. a summon's child sub-room).
  constructor(
    private readonly workspace: Workspace,
    roomId: string = workspace.config.room,
    store: RoomStore = new V1FileRoomStore(workspace.roomsDir, roomId),
  ) {
    this.id = roomId;
    this.store = store;
    this.dir = store.dir;
    this.transcriptPath = store.transcriptPath;
    this.statePath = store.statePath;
  }

  // Wipe the room transcript (backs /clear). Leaves the file present-but-empty
  // so readers see a clean room.
  async clearTranscript(): Promise<void> {
    await this.store.clearTranscript();
  }

  async copyTranscriptTo(destination: RoomStore): Promise<void> {
    await this.store.copyTranscriptTo(destination);
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
    await this.store.appendEvent(event);
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
    await this.store.appendEvent(event);
    return event;
  }

  async recentEvents(): Promise<RoomEvent[]> {
    return this.store.recentEvents(this.workspace.config.transcriptWindow);
  }

  async eventsAfterCursor(cursor: number): Promise<{ events: RoomEvent[]; nextCursor: number }> {
    return this.store.eventsAfterCursor(cursor);
  }

  async readState(): Promise<RoomState> {
    return this.store.readState();
  }

  async writeState(state: RoomState): Promise<void> {
    await this.store.writeState(state);
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
