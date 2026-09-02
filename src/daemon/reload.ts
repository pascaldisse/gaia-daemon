// Settings hot-reload: workspace/global settings-file saves (or a
// workspace-default-agent change) must reach every affected room's live
// RoomService without a daemon restart. Split out of daemon.ts (A7) — state
// (the maps/fields below) stays on Daemon; this module holds only the logic,
// parameterized over a `host` shaped like Daemon so behaviour is unchanged —
// see daemon.ts's thin delegating wrappers.

import type { RoomService } from "../services/room-service.js";
import type { ModelChoice } from "../services/hints.js";
import type { UiEvent } from "../core/types.js";
import { serviceKey } from "./wiring.js";

/** Everything the reload functions below need from Daemon. A plain interface
 * (not `Daemon` itself); the daemon.ts wrappers pass `this`, which satisfies
 * this shape structurally. */
export interface ReloadHost {
  readonly services: Map<string, RoomService>;
  readonly pendingReloads: Set<string>;
  hintSourcesCache: { toolNames: string[]; models: ModelChoice[] } | undefined;
  serviceFor(workspaceId: string, roomId?: string): Promise<RoomService>;
  broadcast(event: UiEvent): void;
}

/** Settings files feed workspace/agent definitions cached at service
 * creation. Rebuild affected services so saves apply without a restart. */
export async function applySettingsChange(host: ReloadHost, scope: "global" | "workspace", workspaceId?: string): Promise<void> {
  host.hintSourcesCache = undefined;
  const keys = scope === "global" ? [...host.services.keys()] : workspaceId ? workspaceServiceKeys(host, workspaceId) : [];
  await Promise.all(keys.map((key) => reloadService(host, key)));
}

export function workspaceServiceKeys(host: ReloadHost, workspaceId: string): string[] {
  const prefix = serviceKey(workspaceId, "");
  return [...host.services.keys()].filter((key) => key.startsWith(prefix));
}

export async function reloadService(host: ReloadHost, key: string): Promise<void> {
  const service = host.services.get(key);
  if (!service) return;

  if (service.hasActiveTask) {
    // Deferred while a turn runs; re-attempted when it settles.
    if (host.pendingReloads.has(key)) return;
    host.pendingReloads.add(key);
    void service
      .waitForIdle()
      .then(() => {
        host.pendingReloads.delete(key);
        return reloadService(host, key);
      })
      .catch(() => host.pendingReloads.delete(key));
    return;
  }

  const { workspaceId, roomId } = service;
  // signals are sent synchronously inside dispose(); waiting is only needed at shutdown
  void service.dispose();
  host.services.delete(key);
  const fresh = await host.serviceFor(workspaceId, roomId);
  host.broadcast({ type: "snapshot", workspaceId, roomId: fresh.roomId, snapshot: await fresh.getSnapshot() });
}
