// A "setup" is a saved bundle — agents + roles + a monad config + skills — loaded
// into a room with one command. This is the user's own idea (the Fugu papers have
// no team/profile concept); it sits on top of the monad engine. Activation reuses
// existing primitives only: room state (activeRoles + the monad block), the role
// resolver's project roles dir, and workspace config. No new search paths.
//
// Discovery precedence: project (.gaia/setups) > global (~/.gaia/setups) >
// repo-bundled (setups/). A setup id resolves to the first directory that has it.
//
// This module also carries the two setup-facing CLI surfaces: `gaia setup …`
// (runSetupCli, offline) and `gaia serve <room>` (runServeCli, exposes a monad
// room as one OpenAI-compatible model — "answer as one" on the outside, real
// summoned child rooms underneath).

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { bundledDir, globalPaths, workspacePaths } from "../core/paths.js";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../core/store.js";
import { json, parseBody } from "../core/http.js";
import type { ChatMessage, MonadConfig, MonadSlot, Workspace } from "../core/types.js";
import { normalizeRoomState } from "../domain/rooms.js";
import { parseRoleMarkdown, resolveAgentRole } from "../domain/roles.js";
import { ensureWorkspaceRoom, liveMaxSummonsPerRoom, loadWorkspace } from "../domain/workspace.js";
import { MemoryStore } from "../domain/memory.js";
import { MonadEngine } from "./monad.js";
import { SummonCoordinator, type SummonRoomAccess } from "./summons.js";
import { parseRoutingPolicy } from "./policies/index.js";

interface RawSlot {
  index?: number;
  agentId?: string;
  label?: string;
  defaultRole?: string;
}

interface RawMonad {
  policy?: string;
  policyConfig?: unknown;
  slots?: RawSlot[];
  roles?: string[];
  maxTurns?: number;
  coordinatorAgentId?: string;
  terminate?: { on?: string; acceptToken?: string };
}

interface RawBinding {
  ref?: string;
  role?: string;
}

export interface SetupManifest {
  id: string;
  displayName?: string;
  description?: string;
  version?: string;
  roomDefaults?: Record<string, unknown>;
  monad?: RawMonad;
  agents?: RawBinding[];
  roles?: Record<string, string>;
  coordinator?: { agent?: { ref?: string; from?: string; role?: string }; role?: string; skills?: string[] };
}

export interface SetupInfo {
  id: string;
  dir: string;
  source: "project" | "global" | "bundled";
  displayName: string;
  description: string;
}

async function readManifest(dir: string): Promise<SetupManifest | undefined> {
  const raw = await readJson(join(dir, "setup.json"));
  if (!raw || typeof raw !== "object") return undefined;
  const manifest = raw as SetupManifest;
  if (typeof manifest.id !== "string" || !manifest.id.trim()) return undefined;
  return manifest;
}

async function scanDir(dir: string, source: SetupInfo["source"]): Promise<SetupInfo[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const found: SetupInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const setupDir = join(dir, entry.name);
    const manifest = await readManifest(setupDir);
    if (!manifest) continue;
    found.push({
      id: manifest.id,
      dir: setupDir,
      source,
      displayName: manifest.displayName ?? manifest.id,
      description: manifest.description ?? "",
    });
  }
  return found;
}

/** All discoverable setups, project/global shadowing bundled by id. */
export async function discoverSetups(workspaceRoot: string): Promise<SetupInfo[]> {
  // Lowest precedence first, then let later sources overwrite by id.
  const layers = [
    await scanDir(bundledDir("setups"), "bundled"),
    await scanDir(globalPaths.setupsDir(), "global"),
    await scanDir(workspacePaths.setupsDir(workspaceRoot), "project"),
  ];
  const byId = new Map<string, SetupInfo>();
  for (const layer of layers) for (const info of layer) byId.set(info.id, info);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Resolve a setup id (or a direct path) to its directory + manifest. */
export async function resolveSetup(workspaceRoot: string, idOrPath: string): Promise<{ info: SetupInfo; manifest: SetupManifest }> {
  // A path argument (absolute, or with a separator) is used directly.
  if (isAbsolute(idOrPath) || idOrPath.includes("/")) {
    const dir = resolve(workspaceRoot, idOrPath);
    const manifest = await readManifest(dir);
    if (!manifest) throw new Error(`No setup.json at ${dir}`);
    return {
      info: { id: manifest.id, dir, source: "project", displayName: manifest.displayName ?? manifest.id, description: manifest.description ?? "" },
      manifest,
    };
  }
  const all = await discoverSetups(workspaceRoot);
  const info = all.find((candidate) => candidate.id === idOrPath);
  if (!info) throw new Error(`Unknown setup: ${idOrPath}. Available: ${all.map((s) => s.id).join(", ") || "(none)"}`);
  const manifest = await readManifest(info.dir);
  if (!manifest) throw new Error(`Setup ${idOrPath} has no readable setup.json`);
  return { info, manifest };
}

function normalizeSlots(raw: RawSlot[] | undefined): MonadSlot[] {
  if (!Array.isArray(raw)) return [];
  const slots: MonadSlot[] = [];
  raw.forEach((entry, position) => {
    if (!entry || typeof entry.agentId !== "string" || !entry.agentId.trim()) return;
    slots.push({
      index: typeof entry.index === "number" ? entry.index : position,
      agentId: entry.agentId,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.defaultRole ? { defaultRole: entry.defaultRole } : {}),
    });
  });
  return slots;
}

function roleBindings(manifest: SetupManifest, slots: MonadSlot[]): RawBinding[] {
  return manifest.agents ?? slots.map((slot) => ({ ref: slot.agentId, role: slot.defaultRole }));
}

// Read each bound role file and inline its body (frontmatter stripped) keyed by
// role name, so the activated room carries self-contained role prompts.
async function buildRolePrompts(setupDir: string, manifest: SetupManifest, slots: MonadSlot[]): Promise<Record<string, string>> {
  const prompts: Record<string, string> = {};
  for (const binding of roleBindings(manifest, slots)) {
    const role = binding.role;
    const ref = binding.ref;
    if (!role || !ref) continue;
    const rel = manifest.roles?.[ref];
    if (!rel) continue;
    const path = resolve(setupDir, rel);
    if (!existsSync(path)) continue;
    const body = parseRoleMarkdown(await readFile(path, "utf8"), path).body.trim();
    if (body) prompts[role] = body;
  }
  return prompts;
}

/** Build the MonadConfig a setup activates, fully validated. */
export async function buildMonadConfig(setupDir: string, manifest: SetupManifest, workspace: Workspace): Promise<MonadConfig> {
  const monad = manifest.monad ?? {};
  const policy = parseRoutingPolicy(monad.policy);
  if (!policy) throw new Error(`Setup ${manifest.id}: unknown or missing monad.policy "${monad.policy}".`);

  const slots = normalizeSlots(monad.slots);
  if (slots.length === 0) throw new Error(`Setup ${manifest.id}: monad.slots is empty.`);

  const missing = slots.filter((slot) => !workspace.agents[slot.agentId]).map((slot) => slot.agentId);
  if (missing.length > 0) {
    throw new Error(`Setup ${manifest.id}: slot agents not found in workspace: ${missing.join(", ")}. Run \`gaia init\` or create them first.`);
  }

  const rolePrompts = await buildRolePrompts(setupDir, manifest, slots);
  const roles =
    Array.isArray(monad.roles) && monad.roles.length > 0
      ? monad.roles.filter((role) => typeof role === "string")
      : [...new Set(slots.map((slot) => slot.defaultRole).filter((role): role is string => Boolean(role)))];

  // Coordinator: an explicit, existing agent wins; else the named coordinator
  // agent if it exists; else the first slot (the thinker routes).
  const named = monad.coordinatorAgentId ?? manifest.coordinator?.agent?.ref;
  const coordinatorAgentId = named && workspace.agents[named] ? named : slots[0].agentId;

  const terminate =
    monad.terminate && monad.terminate.on === "verifier-accept" && typeof monad.terminate.acceptToken === "string"
      ? { on: "verifier-accept" as const, acceptToken: monad.terminate.acceptToken }
      : undefined;

  return {
    policy,
    ...(monad.policyConfig !== undefined ? { policyConfig: monad.policyConfig } : {}),
    slots,
    roles,
    maxTurns: typeof monad.maxTurns === "number" && monad.maxTurns > 0 ? Math.floor(monad.maxTurns) : 5,
    coordinatorAgentId,
    ...(terminate ? { terminate } : {}),
    ...(Object.keys(rolePrompts).length > 0 ? { rolePrompts } : {}),
  };
}

export interface ActivationResult {
  setupId: string;
  roomId: string;
  monad: MonadConfig;
  placedRoles: string[];
}

// Copy each bound role file into its agent's project roles dir, so the existing
// role resolver finds it (no new search path). Best-effort: a missing source or
// unknown agent is skipped, not fatal — the engine path uses inlined prompts.
async function placeRoleFiles(setupDir: string, manifest: SetupManifest, workspace: Workspace, slots: MonadSlot[]): Promise<string[]> {
  const placed: string[] = [];
  for (const binding of roleBindings(manifest, slots)) {
    const ref = binding.ref;
    const role = binding.role;
    if (!ref || !role || !workspace.agents[ref]) continue;
    const rel = manifest.roles?.[ref];
    if (!rel) continue;
    const src = resolve(setupDir, rel);
    if (!existsSync(src)) continue;
    const dest = join(workspace.agentsOverrideDir, ref, "persona", "roles", `${role}.md`);
    await writeTextAtomic(dest, await readFile(src, "utf8"));
    placed.push(`${ref}:${role}`);
  }
  return placed;
}

// Merge a setup's roomDefaults into workspace config.json (best-effort: only keys
// the config already understands take effect; unknowns are written but ignored).
async function applyRoomDefaults(workspace: Workspace, manifest: SetupManifest): Promise<void> {
  if (!manifest.roomDefaults || Object.keys(manifest.roomDefaults).length === 0) return;
  const raw = (await readJson(workspace.configPath)) as Record<string, unknown> | undefined;
  const config = raw && typeof raw === "object" ? { ...raw } : {};
  for (const [key, value] of Object.entries(manifest.roomDefaults)) {
    if (config[key] === undefined) config[key] = value;
  }
  await writeJsonAtomic(workspace.configPath, config);
}

/**
 * Activate a setup into a room: place role files, set active roles, write the
 * monad block onto room state, and apply room defaults. After this the room is a
 * monad room and its next plain user message runs the engine.
 */
export async function activateSetup(workspace: Workspace, idOrPath: string, roomId: string): Promise<ActivationResult> {
  const { info, manifest } = await resolveSetup(workspace.rootDir, idOrPath);
  const monad = await buildMonadConfig(info.dir, manifest, workspace);
  const slots = monad.slots;

  await ensureWorkspaceRoom(workspace.rootDir, roomId);
  const placedRoles = await placeRoleFiles(info.dir, manifest, workspace, slots);

  const statePath = workspacePaths.roomState(workspace.rootDir, roomId);
  const state = normalizeRoomState(await readJson(statePath));
  for (const binding of roleBindings(manifest, slots)) {
    if (binding.ref && binding.role && workspace.agents[binding.ref]) state.activeRoles[binding.ref] = binding.role;
  }
  state.monad = monad;
  await writeJsonAtomic(statePath, state);

  await applyRoomDefaults(workspace, manifest);

  return { setupId: info.id, roomId, monad, placedRoles };
}

/** Read the active monad config for a room (or undefined when not a monad room). */
export async function readRoomMonad(workspace: Workspace, roomId: string): Promise<MonadConfig | undefined> {
  const state = normalizeRoomState(await readJson(workspacePaths.roomState(workspace.rootDir, roomId)));
  return state.monad;
}

/** Clear a room's monad block, returning it to a normal room. */
export async function deactivateMonad(workspace: Workspace, roomId: string): Promise<boolean> {
  const statePath = workspacePaths.roomState(workspace.rootDir, roomId);
  const state = normalizeRoomState(await readJson(statePath));
  if (!state.monad) return false;
  delete state.monad;
  await writeJsonAtomic(statePath, state);
  return true;
}

// ---------------------------------------------------------------------------
// `gaia setup …` — the offline CLI surface. Reads/writes the workspace directly
// (no running daemon needed); a daemon already serving the room picks up the
// change on its next reload / room reselect.

const SETUP_USAGE = `Usage:
  gaia setup list                    list available setups
  gaia setup activate <id> [room]    load a setup into a room (default: the workspace's current room)
  gaia setup status [room]           show a room's active setup
  gaia setup off [room]              clear the monad from a room`;

/** Dispatches `gaia setup …`. Returns a process exit code. */
export async function runSetupCli(args: string[], cwd = process.cwd()): Promise<number> {
  const sub = args[0];

  let workspace: Workspace;
  try {
    workspace = await loadWorkspace(cwd);
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const currentRoom = workspace.config.room;

  if (!sub || sub === "list") {
    const setups = await discoverSetups(workspace.rootDir);
    if (setups.length === 0) {
      console.log("No setups found (looked in setups/, ~/.gaia/setups/, .gaia/setups/).");
      return 0;
    }
    for (const setup of setups) {
      console.log(`${setup.id}${setup.displayName && setup.displayName !== setup.id ? ` — ${setup.displayName}` : ""} [${setup.source}]`);
      if (setup.description) console.log(`  ${setup.description}`);
    }
    return 0;
  }

  if (sub === "activate") {
    const id = args[1];
    const room = args[2] ?? currentRoom;
    if (!id) {
      console.error(SETUP_USAGE);
      return 1;
    }
    try {
      const result = await activateSetup(workspace, id, room);
      const pool = result.monad.slots.map((slot) => `@${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
      console.log(`Activated '${result.setupId}' into room '${room}'.`);
      console.log(`  policy: ${result.monad.policy}   maxTurns: ${result.monad.maxTurns}   coordinator: @${result.monad.coordinatorAgentId}`);
      console.log(`  pool: ${pool}`);
      if (result.placedRoles.length > 0) console.log(`  roles placed: ${result.placedRoles.join(", ")}`);
      console.log(`Send a message to room '${room}' to run the monad; each step appears as a child room.`);
      return 0;
    } catch (error) {
      console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (sub === "status") {
    const room = args[1] ?? currentRoom;
    const monad = await readRoomMonad(workspace, room);
    if (!monad) {
      console.log(`Room '${room}' is not a monad room.`);
      return 0;
    }
    const pool = monad.slots.map((slot) => `@${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
    console.log(`Room '${room}' — policy: ${monad.policy}, maxTurns: ${monad.maxTurns}, coordinator: @${monad.coordinatorAgentId ?? monad.slots[0]?.agentId}`);
    console.log(`  pool: ${pool}`);
    return 0;
  }

  if (sub === "off") {
    const room = args[1] ?? currentRoom;
    const cleared = await deactivateMonad(workspace, room);
    console.log(cleared ? `Cleared the monad from room '${room}'.` : `Room '${room}' had no active monad.`);
    return 0;
  }

  console.error(`Unknown setup subcommand: ${sub}\n\n${SETUP_USAGE}`);
  return 1;
}

// ---------------------------------------------------------------------------
// `gaia serve <room>` — expose a monad room as a single model over an
// OpenAI-compatible endpoint. A request's last user message runs through the
// MonadEngine and the one final answer comes back. The steps run as real
// summons through an in-process coordinator, exactly as in the daemon.
// (v1 had a serve-adapter registry with one adapter; v2 folds that single
// OpenAI-compatible surface in here — the --adapter flag stays for the CLI
// contract and rejects anything else.)

const SERVE_USAGE = `Usage: gaia serve <room> [--port N] [--host H] [--adapter id]`;
const SERVE_ADAPTER = "openai-compatible";

function parseServeArgs(args: string[]): { room?: string; port: number; host: string; adapter: string } {
  let room: string | undefined;
  let port = 8799;
  let host = "127.0.0.1";
  let adapter = SERVE_ADAPTER;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") port = Number.parseInt(args[++i] ?? "", 10);
    else if (arg === "--host") host = args[++i] ?? host;
    else if (arg === "--adapter") adapter = args[++i] ?? adapter;
    else if (!arg.startsWith("--") && !room) room = arg;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) port = 8799;
  return { room, port, host, adapter };
}

function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages.length > 0 ? messages[messages.length - 1].content : "";
}

function chatMessagesFrom(body: unknown): ChatMessage[] {
  const raw = body && typeof body === "object" ? (body as { messages?: unknown }).messages : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is { role?: unknown; content?: unknown } => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({ role: typeof entry.role === "string" ? entry.role : "user", content: typeof entry.content === "string" ? entry.content : "" }));
}

function serveCompletionPayload(id: string, content: string): unknown {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: "gaia-monad",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

interface ServeHandle {
  url: string;
  stop(): Promise<void>;
}

async function startServeEndpoint(host: string, port: number, run: (messages: ChatMessage[]) => Promise<string>): Promise<ServeHandle> {
  let counter = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://gaia.local");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        json(response, 200, { object: "list", data: [{ id: "gaia-monad", object: "model", created: 0, owned_by: "gaia" }] });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const messages = chatMessagesFrom(await parseBody(request));
        if (messages.length === 0) {
          json(response, 400, { error: { message: "Request contains no messages", type: "invalid_request_error" } });
          return;
        }
        const answer = await run(messages);
        json(response, 200, serveCompletionPayload(`chatcmpl-${++counter}`, answer));
        return;
      }
      json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    })().catch((error) => {
      if (!response.headersSent) json(response, 500, { error: { message: error instanceof Error ? error.message : String(error), type: "server_error" } });
      else response.end();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  return {
    url: `http://${host}:${boundPort}/v1`,
    stop: () => new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}

/** What the serve host needs from a per-room service (RoomService satisfies it). */
interface ServeRoomService extends SummonRoomAccess {
  init(): Promise<void>;
  dispose(): void | Promise<void>;
}

/** Dispatches `gaia serve …`. Returns a process exit code (long-running on success). */
export async function runServeCli(args: string[], cwd = process.cwd()): Promise<number> {
  const { room, port, host, adapter } = parseServeArgs(args);
  if (!room) {
    console.error(SERVE_USAGE);
    return 1;
  }
  if (adapter !== SERVE_ADAPTER) {
    console.error(`gaia: unsupported serve adapter: ${adapter} (available: ${SERVE_ADAPTER})`);
    return 1;
  }

  let workspace: Workspace;
  try {
    workspace = await loadWorkspace(cwd);
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const monad = await readRoomMonad(workspace, room);
  if (!monad) {
    console.error(`gaia: room '${room}' is not a monad room. Run \`gaia setup activate <id> ${room}\` first.`);
    return 1;
  }

  // Deferred so loading this module never drags in the whole runtime stack
  // (and the type-level cycle setups → room-service → setups stays lazy).
  const { RoomService } = await import("./room-service.js");

  // Minimal headless host: a per-child-room service factory + a summon
  // coordinator, the same wiring the daemon builds (without the HTTP bridge —
  // worker steps run; memory-write/nested-summon inside a step are unavailable).
  const services = new Map<string, ServeRoomService>();
  const memoryStore = new MemoryStore();
  let coordinator: SummonCoordinator;
  const serviceForRoom = async (roomId: string): Promise<ServeRoomService> => {
    const existing = services.get(roomId);
    if (existing) return existing;
    await ensureWorkspaceRoom(cwd, roomId);
    const service = await RoomService.open({ workspaceId: "serve", workspace, roomId, memoryStore, summonHost: coordinator });
    await service.init();
    services.set(roomId, service);
    return service;
  };
  coordinator = new SummonCoordinator(workspace, cwd, serviceForRoom, () => liveMaxSummonsPerRoom(cwd));

  await ensureWorkspaceRoom(cwd, room);

  const run = async (messages: ChatMessage[]): Promise<string> => {
    const engine = new MonadEngine({
      config: monad,
      parentRoomId: room,
      dispatch: (agentId, task) => coordinator.summonAndWait(room, agentId, task),
      resolveRolePrompt: async (agentId, role) => {
        const agent = workspace.agents[agentId];
        if (!agent) return "";
        return (await resolveAgentRole(agent, role))?.prompt ?? "";
      },
    });
    const result = await engine.run(lastUserMessage(messages));
    return result.final;
  };

  const handle = await startServeEndpoint(host, port, run);
  console.log(`gaia serve — monad room '${room}' as one model via ${adapter}`);
  console.log(`  endpoint: ${handle.url}`);
  console.log(`  policy: ${monad.policy}   pool: ${monad.slots.map((slot) => `@${slot.agentId}`).join(" · ")}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolveStop) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void Promise.all([...services.values()].map((service) => service.dispose()))
        .then(() => handle.stop())
        .finally(resolveStop);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
