// Service construction / dependency-injection wiring for the daemon's per-room
// RoomService instances: get-or-create + LRU eviction, the closures that hand
// each RoomService its collaborators (memory store/service, summon
// coordinator, consolidation LLM, harness bridge, scheduler), and the
// boot-time recovery sweeps that wake rooms with unfinished work. Split out of
// daemon.ts (A7); daemon.ts keeps all state (the maps/fields below live on
// Daemon), this module only holds the logic, parameterized over a `host`
// shaped like Daemon so behaviour is unchanged — see daemon.ts's thin
// delegating wrappers.

import { existsSync, readdirSync } from "node:fs";
import { readJson } from "../core/store.js";
import { DEFAULTS } from "../core/config.js";
import { workspacePaths } from "../core/paths.js";
import type { RoomState, Workspace } from "../core/types.js";
import { normalizeRoomState } from "../domain/rooms.js";
import { ensureWorkspaceRoom, liveMaxSummonsPerRoom, loadWorkspace } from "../domain/workspace.js";
import { workspaceRoomRefs, type RoomRef } from "../domain/workspace-index.js";
import { MemoryStore } from "../domain/memory.js";
import { findModelWithAlias } from "../harness/model-aliases.js";
import { RoomService } from "../services/room-service.js";
import { MemoryService } from "../services/memory-service.js";
import type { ConsolidateLlm } from "../services/consolidate.js";
import { SummonCoordinator } from "../services/summons.js";
import type { HarnessBridge } from "../services/bridge.js";
import type { SchedulerService } from "../services/scheduler.js";
import type { EmbedSidecar } from "../services/embed-sidecar.js";
import type { WiringHost } from "./ports.js";

/** Soft cap on simultaneously-resident room services. Idle rooms past this are
 * evicted (transcripts persist on disk); busy ones are always kept. */
const MAX_LIVE_SERVICES = 32;

/** Grace window protecting a just-handed-out service from eviction. `serviceFor`
 * returns an idle service to a caller that then `await`s several times (init +
 * routing) before `sendMessage` sets `activeTask` — until then `isBusy` is
 * false, so a concurrent `serviceFor` (constant under heavy summon fan-out) can
 * `evictIdleServices()` and dispose the runtimes out from under the in-flight
 * turn: the message persists but no turn ever runs, and it takes a SECOND
 * message (which re-creates the room) to get a reply. Any service handed out
 * within this window is treated as busy so the hand-off can complete. */
const HANDOFF_GRACE_MS = 30_000;

export function serviceKey(workspaceId: string, roomId: string): string {
  return `${workspaceId}::${roomId}`;
}

// --- consolidation LLM (daemon-side, same credential store as the proxy) ---------

/** Builds the completion function consolidation uses. Resolved lazily per call
 * so key/model changes apply without a daemon restart; no key → the call
 * throws and consolidation skips with the error as its reason. */
function consolidateLlm(): ConsolidateLlm {
  return async ({ system, user, model }) => {
    const provider = model?.provider ?? DEFAULTS.model.provider;
    const name = model?.name ?? DEFAULTS.model.name;
    const [{ completeSimple }, { ModelRegistry, ModelRuntime }] = await Promise.all([
      // completeSimple moved to the compat subpath in pi-ai 0.80 (same shape).
      import("@earendil-works/pi-ai/compat"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    const runtime = await ModelRuntime.create();
    // Alias fallback (RULE #0): short tier names (fable/opus/sonnet/haiku) in an
    // agent's config resolve here too — this direct pi-ai path bypasses the
    // harness CLI, so an un-aliased `find` was silently killing consolidation
    // for any agent configured with a short name (e.g. anthropic/fable).
    const resolved = findModelWithAlias(new ModelRegistry(runtime), provider, name);
    if (!resolved) throw new Error(`consolidation model not found: ${provider}/${name}`);
    const apiKey = (await runtime.getAuth(provider))?.auth.apiKey;
    const message = await completeSimple(
      resolved,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { ...(apiKey ? { apiKey } : {}), maxTokens: 4_000 },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "consolidation model call failed");
    }
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  };
}

// --- room services ------------------------------------------------------------

/** Get-or-create the long-lived service for a (workspace, room). Omitted room
 * = the workspace's current room. LRU-bumped; creating past the soft cap
 * evicts the least-recently-used idle room. */
export async function serviceFor(host: WiringHost, workspaceId: string, roomId?: string): Promise<RoomService> {
  // Enforce the invariant boot() documents at its reapOrphans() call: nothing
  // resumes/starts a turn until the stale-runner sweep has settled. Without
  // this, a message landing right after a restart (the HTTP server accepts
  // connections before boot() finishes — see http.ts) could start a fresh
  // turn/runner for a room while a surviving orphan runner for that same
  // room+agent is still being identified/killed.
  await host.orphanSweepDone;
  const resolvedRoom = roomId ?? (await resolveCurrentRoom(host, workspaceId));
  const key = serviceKey(workspaceId, resolvedRoom);

  const existing = host.services.get(key);
  if (existing) {
    host.services.delete(key);
    host.services.set(key, existing);
    host.handedOutAt.set(key, Date.now());
    return existing;
  }

  // A creation already in flight IS this room's service — join it.
  const pending = host.servicePending.get(key);
  if (pending) {
    host.handedOutAt.set(key, Date.now());
    return pending;
  }
  const creation = createService(host, workspaceId, resolvedRoom, key);
  host.servicePending.set(key, creation);
  try {
    return await creation;
  } finally {
    host.servicePending.delete(key);
  }
}

async function createService(host: WiringHost, workspaceId: string, resolvedRoom: string, key: string): Promise<RoomService> {
  const record = await host.registry.find(workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
  await ensureWorkspaceRoom(record.path, resolvedRoom);
  const workspace = await loadWorkspace(record.path);
  const service = await RoomService.open({
    workspaceId,
    workspace,
    roomId: resolvedRoom,
    memoryStore: memoryStoreFor(host, workspaceId),
    memory: memoryServiceFor(host, workspaceId, workspace, record.path),
    // Same LLM caller consolidation uses — backs the context-gate compact.
    llm: consolidateLlm(),
    summonHost: summonCoordinatorFor(host, workspaceId, workspace, record.path),
    setThinking: async (agentId, level) => (await host.applyThinking(workspaceId, resolvedRoom, agentId, level)).message,
    // Same reload the settings-file save route uses: /model + /thinking
    // rewrite agent.json, and only a service rebuild reaches the runner
    // subprocesses (they snapshot the config at spawn).
    settingsChanged: (scope) => host.applySettingsChange(scope, workspaceId),
    harnessHost: host.bridge ? (opts) => host.bridge!.hostFor(workspaceId, opts) : undefined,
    // Closures resolve host.scheduler per call: services built before boot()
    // (or after dispose) answer gracefully instead of binding a stale ref.
    scheduler: {
      list: () => host.scheduler?.describeWorkspace(workspaceId, record.path) ?? Promise.resolve("The scheduler is not running."),
      runNow: (jobId) => host.scheduler?.runNow(workspaceId, record.path, jobId) ?? Promise.resolve("The scheduler is not running."),
    },
  });
  service.subscribe((event) => {
    host.broadcast(event);
    // A finished turn just spent tokens — refresh the account usage chip so it
    // tracks live instead of waiting for the slow poll.
    if (event.type === "task-end" || event.type === "task-error") host.scheduleUsageRefresh();
  });
  await service.init();
  host.services.set(key, service);
  host.handedOutAt.set(key, Date.now());
  evictIdleServices(host);
  return service;
}

async function resolveCurrentRoom(host: WiringHost, workspaceId: string): Promise<string> {
  const cached = host.currentRoom.get(workspaceId);
  if (cached) return cached;
  const record = await host.registry.find(workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
  const workspace = await loadWorkspace(record.path);
  host.currentRoom.set(workspaceId, workspace.config.room);
  return workspace.config.room;
}

function evictIdleServices(host: WiringHost): void {
  const now = Date.now();
  for (const [key, service] of host.services) {
    if (host.services.size <= MAX_LIVE_SERVICES) break;
    if (service.isBusy) continue;
    // A just-handed-out service is idle only because its caller hasn't reached
    // startTask yet; disposing it here loses the in-flight turn (see
    // HANDOFF_GRACE_MS). Treat the hand-off window as busy.
    if (now - (host.handedOutAt.get(key) ?? 0) < HANDOFF_GRACE_MS) continue;
    // signals are sent synchronously inside dispose(); waiting is only needed at shutdown
    void service.dispose();
    host.services.delete(key);
    host.handedOutAt.delete(key);
    host.log(`evicted idle room service ${key} (soft cap ${MAX_LIVE_SERVICES})`);
  }
}

function memoryStoreFor(host: WiringHost, workspaceId: string): MemoryStore {
  let store = host.memoryStores.get(workspaceId);
  if (!store) {
    store = new MemoryStore();
    host.memoryStores.set(workspaceId, store);
  }
  return store;
}

/** One MemoryService per workspace. Holds live workspace accessors so a
 * settings reload changes behavior without a rebuild; the consolidation LLM
 * runs daemon-side through the same credential store as the proxy. */
export function memoryServiceFor(host: WiringHost, workspaceId: string, workspace: Workspace, path: string): MemoryService {
  const existing = host.memoryServices.get(workspaceId);
  if (existing) {
    // Workspace objects are rebuilt on settings reload; the accessors close
    // over `live`, so refreshing it here keeps the memory service current.
    existing.live.workspace = workspace;
    return existing.service;
  }
  const live = { workspace };
  const service = new MemoryService({
    workspaceRoot: path,
    workspaceMemory: () => live.workspace.config.memory,
    agents: () => live.workspace.agents,
    memoryStore: memoryStoreFor(host, workspaceId),
    roomsFor: () => recentRoomRefs(path),
    llm: consolidateLlm(),
    log: (message) => host.log(message),
    embedderDeps: {
      ensureLocalSidecar: (modelId) => host.embedSidecar.ensure(modelId),
      ensureLocalReranker: (modelId) => host.embedSidecar.ensureRerank(modelId),
    },
  });
  host.memoryServices.set(workspaceId, { service, live });
  return service;
}

/** Every room transcript in the workspace, most-recently-active first, for
 * the workspace memory index (one shared definition: workspaceRoomRefs). */
function recentRoomRefs(workspaceRoot: string): RoomRef[] {
  return workspaceRoomRefs(workspaceRoot);
}

function summonCoordinatorFor(host: WiringHost, workspaceId: string, workspace: Workspace, path: string): SummonCoordinator {
  let coordinator = host.summonCoordinators.get(workspaceId);
  if (!coordinator) {
    coordinator = new SummonCoordinator(
      workspace,
      path,
      (roomId) => serviceFor(host, workspaceId, roomId),
      () => liveMaxSummonsPerRoom(path),
      (message) => host.log(message),
    );
    host.summonCoordinators.set(workspaceId, coordinator);
  }
  return coordinator;
}

export async function coordinatorFor(host: WiringHost, workspaceId: string): Promise<SummonCoordinator> {
  const existing = host.summonCoordinators.get(workspaceId);
  if (existing) return existing;
  const record = await host.registry.find(workspaceId);
  if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
  const workspace = await loadWorkspace(record.path);
  return summonCoordinatorFor(host, workspaceId, workspace, record.path);
}

/** Boot sweep: re-arm undelivered summons in every initialized workspace
 * (see SummonCoordinator.recoverUndelivered). Failures are logged, never
 * thrown — recovery must not take the daemon down. */
export async function recoverSummons(host: WiringHost): Promise<void> {
  for (const record of await host.registry.list()) {
    if (!record.isInitialized) continue;
    try {
      await (await coordinatorFor(host, record.id)).recoverUndelivered();
    } catch (error) {
      host.log(`summon recovery skipped for workspace ${record.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Boot sweep: wake every room whose persisted state carries unfinished work
 * (a pendingTurn or a non-empty queue) — the counterpart to recoverSummons
 * for plain agent turns, which otherwise only resume/drain lazily inside
 * RoomService.initOnce(), on-demand, the next time something calls
 * serviceFor() for that specific room. Scan is cheap (one JSON read per
 * room, no service/workspace load); only rooms that actually need it get a
 * real serviceFor(), which does the rest via initOnce(). Sequential, not
 * fanned out — a restart can strand many rooms at once, and each wake may
 * spawn a runner subprocess; waking them one at a time avoids a subprocess
 * thundering herd (servicePending already makes this race-safe against a
 * concurrent client reconnect for the same room). Failures are logged,
 * never thrown — recovery must not take the daemon down. */
export async function recoverPendingTurns(host: WiringHost): Promise<void> {
  for (const record of await host.registry.list()) {
    if (!record.isInitialized) continue;
    for (const roomId of roomIdsOnDisk(record.path)) {
      let state: RoomState;
      try {
        state = normalizeRoomState(await readJson(workspacePaths.roomState(record.path, roomId)));
      } catch {
        continue; // Unreadable/corrupt state — leave it for the room's own on-open recovery.
      }
      if (!state.pendingTurn && !state.queue?.length) continue;
      host.log(`turn recovery: waking ${record.id}::${roomId} (pending=${Boolean(state.pendingTurn)}, queued=${state.queue?.length ?? 0})`);
      try {
        await serviceFor(host, record.id, roomId);
      } catch (error) {
        host.log(`turn recovery failed for ${record.id}::${roomId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export function roomIdsOnDisk(workspaceRoot: string): string[] {
  const dir = workspacePaths.roomsDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
