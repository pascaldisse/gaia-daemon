/** Explicit daemon-owned contracts for extracted daemon collaborators. */
import type { UiEvent, Workspace } from "../core/types.js";
import type { MemoryStore } from "../domain/memory.js";
import type { RoomService } from "../services/room-service.js";
import type { MemoryService } from "../services/memory-service.js";
import type { SummonCoordinator } from "../services/summons.js";
import type { HarnessBridge } from "../services/bridge.js";
import type { SchedulerService } from "../services/scheduler.js";
import type { EmbedSidecar } from "../services/embed-sidecar.js";
import type { ModelChoice } from "../services/hints.js";
import type { WorkspaceRegistry } from "../daemon.js";

export interface WiringHost {
  readonly registry: WorkspaceRegistry;
  readonly orphanSweepDone: Promise<void>;
  readonly services: Map<string, RoomService>;
  readonly handedOutAt: Map<string, number>;
  readonly servicePending: Map<string, Promise<RoomService>>;
  readonly currentRoom: Map<string, string>;
  readonly memoryStores: Map<string, MemoryStore>;
  readonly memoryServices: Map<string, { service: MemoryService; live: { workspace: Workspace } }>;
  readonly summonCoordinators: Map<string, SummonCoordinator>;
  readonly embedSidecar: EmbedSidecar;
  readonly bridge: HarnessBridge | undefined;
  readonly scheduler: SchedulerService | undefined;
  log(message: string): void;
  broadcast(event: UiEvent): void;
  scheduleUsageRefresh(): void;
  applyThinking(workspaceId: string, roomId: string | undefined, agentId: string, level: string): Promise<{ message: string }>;
  applySettingsChange(scope: "global" | "workspace", workspaceId?: string): Promise<void>;
}

export interface ReloadHost {
  readonly services: Map<string, RoomService>;
  readonly pendingReloads: Set<string>;
  hintSourcesCache: { toolNames: string[]; models: ModelChoice[] } | undefined;
  serviceFor(workspaceId: string, roomId?: string): Promise<RoomService>;
  broadcast(event: UiEvent): void;
}
