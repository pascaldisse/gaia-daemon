// Workspace loading: .gaia/config.json + global/project agents + AGENTS.md
// context chain + room seeding. The single entry every surface (daemon,
// runner subprocess, headless serve) uses to materialize a Workspace.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULTS, MEMORY_DEFAULTS, parseWorkspaceConfig } from "../core/config.js";
import { gaiaHome, workspacePaths } from "../core/paths.js";
import { jsonText, readJson, writeJsonAtomic, writeText } from "../core/store.js";
import type { ContextFile, Workspace, WorkspaceConfig } from "../core/types.js";
import { parseHarness } from "../harness/spec.js";
import { normalizeRoomState } from "./rooms.js";
import { ensureGlobalDefaultAgents, loadAgentDefinitions } from "./agents.js";

export const WORKSPACE_DIRNAME = ".gaia";
export const DEFAULT_ROOM = DEFAULTS.room;

export { gaiaHome };

export function globalAgentsPath(home = gaiaHome()): string {
  return join(home, "agents");
}

export function workspacePath(cwd: string): string {
  return workspacePaths.dir(cwd);
}

export function isValidRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(roomId) && roomId !== "." && roomId !== "..";
}

function assertRoomId(roomId: string): void {
  if (!isValidRoomId(roomId)) throw new Error("Room id must be 1-64 letters, numbers, dots, underscores, or hyphens, and cannot contain slashes.");
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) return;
  await writeText(path, content);
}

export async function ensureWorkspaceRoom(cwd: string, roomId: string): Promise<void> {
  assertRoomId(roomId);
  await writeIfMissing(workspacePaths.transcript(cwd, roomId), "");
  await writeIfMissing(workspacePaths.roomState(cwd, roomId), jsonText(normalizeRoomState(undefined)));
}

/** Scaffold schedules.json so proactive runs are one settings edit away —
 * written on load too, so pre-scheduler workspaces gain the file. */
async function ensureScheduleFile(cwd: string): Promise<void> {
  await writeIfMissing(workspacePaths.schedules(cwd), jsonText({ enabled: true, jobs: [] }));
}

async function updateConfigField(cwd: string, mutate: (config: Record<string, unknown>) => void): Promise<void> {
  const configPath = workspacePaths.config(cwd);
  const raw = await readJson(configPath);
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  mutate(config);
  await writeJsonAtomic(configPath, config);
}

export async function setWorkspaceRoom(cwd: string, roomId: string): Promise<void> {
  assertRoomId(roomId);
  await updateConfigField(cwd, (config) => {
    config.room = roomId;
  });
}

export async function setWorkspaceDefaultAgent(cwd: string, agentId: string): Promise<void> {
  await updateConfigField(cwd, (config) => {
    config.defaultAgent = agentId;
  });
}

function defaultConfigJson(): WorkspaceConfig {
  return {
    defaultAgent: DEFAULTS.defaultAgent,
    room: DEFAULTS.room,
    transcriptWindow: DEFAULTS.transcriptWindow,
    maxSummonsPerRoom: DEFAULTS.maxSummonsPerRoom,
    // Written out (not just implied) so the memory section is visible and
    // editable in the settings UI from day one.
    memory: MEMORY_DEFAULTS,
  };
}

export async function initWorkspace(cwd: string): Promise<{ workspaceDir: string; globalAgentsDir: string }> {
  const workspaceDir = workspacePath(cwd);
  const agentsDir = globalAgentsPath();

  await ensureGlobalDefaultAgents(agentsDir);
  await writeIfMissing(workspacePaths.config(cwd), jsonText(defaultConfigJson()));
  await writeIfMissing(
    join(cwd, "AGENTS.md"),
    `# Project Instructions\n\nThis file is project-local context for GAIA agents.\n\nAdd repo conventions, commands, constraints, and preferences here.\nCanonical agent identity lives in global personas under ~/.gaia/agents/.\n`,
  );
  await ensureWorkspaceRoom(cwd, DEFAULT_ROOM);
  await ensureScheduleFile(cwd);

  return { workspaceDir, globalAgentsDir: agentsDir };
}

/** AGENTS.md files from the filesystem root down to cwd, parent-most first. */
export async function discoverContextFiles(cwd: string): Promise<ContextFile[]> {
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const files: ContextFile[] = [];
  for (const dir of dirs) {
    const path = join(dir, "AGENTS.md");
    if (!existsSync(path)) continue;
    files.push({ path, content: await readFile(path, "utf8") });
  }
  return files;
}

export async function loadWorkspace(cwd: string): Promise<Workspace> {
  const dir = workspacePath(cwd);
  if (!existsSync(dir)) throw new Error(`Missing ${WORKSPACE_DIRNAME} workspace. Run \`gaia init\` first.`);

  const configPath = workspacePaths.config(cwd);
  if (!existsSync(configPath)) throw new Error(`Missing workspace config: ${configPath}`);

  const globalAgentsDir = globalAgentsPath();
  await ensureGlobalDefaultAgents(globalAgentsDir);

  const config = parseWorkspaceConfig(await readJson(configPath), (id) => Boolean(parseHarness(id)));
  // maxSummonsPerRoom falls back through the default rather than staying unset.
  config.maxSummonsPerRoom ??= DEFAULTS.maxSummonsPerRoom;
  const contextFiles = await discoverContextFiles(cwd);
  const agents = await loadAgentDefinitions(globalAgentsDir, workspacePaths.agentsOverrideDir(cwd));

  if (!agents[config.defaultAgent]) throw new Error(`Default agent not found: ${config.defaultAgent}`);
  await ensureWorkspaceRoom(cwd, config.room);
  await ensureScheduleFile(cwd);

  return {
    rootDir: cwd,
    dir,
    configPath,
    agentsOverrideDir: workspacePaths.agentsOverrideDir(cwd),
    roomsDir: workspacePaths.roomsDir(cwd),
    globalAgentsDir,
    config,
    contextFiles,
    agents,
  };
}
