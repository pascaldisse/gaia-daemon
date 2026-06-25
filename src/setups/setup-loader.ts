// A "setup" is a saved bundle — agents + roles + a monad config + skills — loaded
// into a room with one command. This is the user's own idea (the Fugu papers have
// no team/profile concept); it sits on top of the monad engine. Activation reuses
// existing primitives only: room state (activeRoles + the new monad block), the
// role resolver's project roles dir, and workspace config. No new search paths.
//
// Discovery precedence: project (.gaia/setups) > global (~/.gaia/setups) >
// repo-bundled (setups/). A setup id resolves to the first directory that has it.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonFile } from "../lib/fs.js";
import { parseRoleMarkdown } from "../roles/roles.js";
import { ensureWorkspaceRoom, gaiaHome } from "../workspace/workspace-loader.js";
import { readRoomState, roomStatePath, writeRoomState } from "../room/state.js";
import { parseRoutingPolicy } from "../runtime/monad/index.js";
import type { MonadConfig, MonadSlot } from "../runtime/monad/types.js";
import type { Workspace } from "../workspace/types.js";

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

/** The repo-bundled setups directory (setups/), resolved relative to this module. */
function bundledSetupsDir(): string {
  return fileURLToPath(new URL("../../setups", import.meta.url));
}

function globalSetupsDir(): string {
  return join(gaiaHome(), "setups");
}

function projectSetupsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".gaia", "setups");
}

async function readManifest(dir: string): Promise<SetupManifest | undefined> {
  const path = join(dir, "setup.json");
  const raw = await readJsonFile(path);
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
    await scanDir(bundledSetupsDir(), "bundled"),
    await scanDir(globalSetupsDir(), "global"),
    await scanDir(projectSetupsDir(workspaceRoot), "project"),
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
    return { info: { id: manifest.id, dir, source: "project", displayName: manifest.displayName ?? manifest.id, description: manifest.description ?? "" }, manifest };
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

// Read each bound role file and inline its body (frontmatter stripped) keyed by
// role name, so the activated room carries self-contained role prompts.
async function buildRolePrompts(setupDir: string, manifest: SetupManifest, slots: MonadSlot[]): Promise<Record<string, string>> {
  const prompts: Record<string, string> = {};
  const bindings: RawBinding[] = manifest.agents ?? slots.map((slot) => ({ ref: slot.agentId, role: slot.defaultRole }));
  for (const binding of bindings) {
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
  if (missing.length > 0) throw new Error(`Setup ${manifest.id}: slot agents not found in workspace: ${missing.join(", ")}. Run \`gaia init\` or create them first.`);

  const rolePrompts = await buildRolePrompts(setupDir, manifest, slots);
  const roles = Array.isArray(monad.roles) && monad.roles.length > 0 ? monad.roles.filter((role) => typeof role === "string") : [...new Set(slots.map((slot) => slot.defaultRole).filter((role): role is string => Boolean(role)))];

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
  const bindings: RawBinding[] = manifest.agents ?? slots.map((slot) => ({ ref: slot.agentId, role: slot.defaultRole }));
  for (const binding of bindings) {
    const ref = binding.ref;
    const role = binding.role;
    if (!ref || !role || !workspace.agents[ref]) continue;
    const rel = manifest.roles?.[ref];
    if (!rel) continue;
    const src = resolve(setupDir, rel);
    if (!existsSync(src)) continue;
    const dest = join(workspace.rootDir, ".gaia", "agents", ref, "persona", "roles", `${role}.md`);
    await writeFileAtomic(dest, await readFile(src, "utf8"));
    placed.push(`${ref}:${role}`);
  }
  return placed;
}

// Merge a setup's roomDefaults into workspace config.json (best-effort: only keys
// the config already understands take effect; unknowns are written but ignored).
async function applyRoomDefaults(workspace: Workspace, manifest: SetupManifest): Promise<void> {
  if (!manifest.roomDefaults || Object.keys(manifest.roomDefaults).length === 0) return;
  const raw = (await readJsonFile(workspace.configPath)) as Record<string, unknown> | undefined;
  const config = raw && typeof raw === "object" ? { ...raw } : {};
  for (const [key, value] of Object.entries(manifest.roomDefaults)) {
    if (config[key] === undefined) config[key] = value;
  }
  await writeJsonFile(workspace.configPath, config);
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

  const statePath = roomStatePath(workspace.roomsDir, roomId);
  const state = await readRoomState(statePath);
  const bindings: RawBinding[] = manifest.agents ?? slots.map((slot) => ({ ref: slot.agentId, role: slot.defaultRole }));
  for (const binding of bindings) {
    if (binding.ref && binding.role && workspace.agents[binding.ref]) state.activeRoles[binding.ref] = binding.role;
  }
  state.monad = monad;
  await writeRoomState(statePath, state);

  await applyRoomDefaults(workspace, manifest);

  return { setupId: info.id, roomId, monad, placedRoles };
}

/** Read the active monad config for a room (or undefined when not a monad room). */
export async function readRoomMonad(workspace: Workspace, roomId: string): Promise<MonadConfig | undefined> {
  const state = await readRoomState(roomStatePath(workspace.roomsDir, roomId));
  return state.monad;
}

/** Clear a room's monad block, returning it to a normal room. */
export async function deactivateMonad(workspace: Workspace, roomId: string): Promise<boolean> {
  const statePath = roomStatePath(workspace.roomsDir, roomId);
  const state = await readRoomState(statePath);
  if (!state.monad) return false;
  delete state.monad;
  await writeRoomState(statePath, state);
  return true;
}

