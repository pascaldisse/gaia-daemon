// Settings hot-reload: workspace/global settings-file saves (or a
// workspace-default-agent change) must reach every affected room's live
// RoomService without a daemon restart. Split out of daemon.ts (A7) — state
// (the maps/fields below) stays on Daemon; this module holds only the logic,
// parameterized over a `host` shaped like Daemon so behaviour is unchanged —
// see daemon.ts's thin delegating wrappers.

import { loadWorkspace } from "../domain/workspace.js";
import { serviceKey } from "./wiring.js";
import type { ReloadHost } from "./ports.js";

/** Settings files feed workspace/agent definitions cached at service
 * creation. Rebuild affected services so saves apply without a restart. */
export async function applySettingsChange(host: ReloadHost, scope: "global" | "workspace", workspaceId?: string): Promise<void> {
  host.hintSourcesCache = undefined;
  const keys = scope === "global" ? [...host.services.keys()] : workspaceId ? workspaceServiceKeys(host, workspaceId) : [];
  await refreshSummonCoordinators(host, scope, workspaceId);
await Promise.all(keys.map((key) => reloadService(host, key)));
}
/** Cached SummonCoordinators hold the boot-time workspace (agent roster). Swap in
* a fresh one in place so new agents are summonable w/o restart; running lanes survive. */
async function refreshSummonCoordinators(host: ReloadHost, scope: "global" | "workspace", workspaceId?: string): Promise<void> {
const ids = scope === "global" ? [...host.summonCoordinators.keys()] : workspaceId && host.summonCoordinators.has(workspaceId) ? [workspaceId] : [];
await Promise.all(ids.map(async (id) => {
const record = await host.registry.find(id);
const coordinator = host.summonCoordinators.get(id);
if (!record || !coordinator) return;
coordinator.updateWorkspace(await loadWorkspace(record.path));
}));
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
