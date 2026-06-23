import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureGlobalDefaultAgents, loadAgentDefinitions } from "../agents/registry.js";
import { jsonText, writeIfMissing, writeJsonFile } from "../lib/fs.js";
import { defaultRoomState } from "../room/state.js";
import { discoverContextFiles } from "./context-files.js";
import type { Workspace, WorkspaceConfig } from "./types.js";

export const WORKSPACE_DIRNAME = ".gaia";
export const DEFAULT_ROOM = "default";

export function gaiaHome(): string {
  const env = process.env.GAIA_HOME?.trim();
  return resolve(env ? env : join(homedir(), ".gaia"));
}

export function globalAgentsPath(home = gaiaHome()): string {
  return join(home, "agents");
}

function workspaceFile(cwd: string, ...parts: string[]): string {
  return join(cwd, WORKSPACE_DIRNAME, ...parts);
}

function defaultConfig(): WorkspaceConfig {
  return {
    defaultAgent: "gaia",
    room: DEFAULT_ROOM,
    transcriptWindow: 20,
    maxSummonsPerRoom: 8,
  };
}

function parseHarness(raw: unknown): "pi" | "codex" | "claude" | undefined {
  if (raw === "pi" || raw === "codex" || raw === "claude") return raw;
  return undefined;
}

function mergeConfig(raw: unknown): WorkspaceConfig {
  const base = defaultConfig();
  const input = raw && typeof raw === "object" ? (raw as Partial<WorkspaceConfig>) : {};
  return {
    defaultAgent: typeof input.defaultAgent === "string" && input.defaultAgent.trim() ? input.defaultAgent : base.defaultAgent,
    room: typeof input.room === "string" && input.room.trim() ? input.room : base.room,
    transcriptWindow:
      typeof input.transcriptWindow === "number" && Number.isFinite(input.transcriptWindow) && input.transcriptWindow > 0
        ? Math.floor(input.transcriptWindow)
        : base.transcriptWindow,
    harness: parseHarness(input.harness),
    maxSummonsPerRoom:
      typeof input.maxSummonsPerRoom === "number" && Number.isFinite(input.maxSummonsPerRoom) && input.maxSummonsPerRoom > 0
        ? Math.floor(input.maxSummonsPerRoom)
        : base.maxSummonsPerRoom,
  };
}

export function workspacePath(cwd: string): string {
  return join(cwd, WORKSPACE_DIRNAME);
}

export function isValidRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(roomId) && roomId !== "." && roomId !== "..";
}

function assertRoomId(roomId: string): void {
  if (!isValidRoomId(roomId)) throw new Error("Room id must be 1-64 letters, numbers, dots, underscores, or hyphens, and cannot contain slashes.");
}

export async function ensureWorkspaceRoom(cwd: string, roomId: string): Promise<void> {
  assertRoomId(roomId);
  await writeIfMissing(workspaceFile(cwd, "rooms", roomId, "transcript.jsonl"), "");
  await writeIfMissing(workspaceFile(cwd, "rooms", roomId, "state.json"), jsonText(defaultRoomState()));
}

export async function setWorkspaceRoom(cwd: string, roomId: string): Promise<void> {
  assertRoomId(roomId);
  const configPath = workspaceFile(cwd, "config.json");
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  config.room = roomId;
  await writeJsonFile(configPath, config);
}

export async function initWorkspace(cwd: string): Promise<{ workspaceDir: string; globalAgentsDir: string }> {
  const workspaceDir = workspacePath(cwd);
  const agentsDir = globalAgentsPath();

  await ensureGlobalDefaultAgents(agentsDir);
  await writeIfMissing(workspaceFile(cwd, "config.json"), jsonText(defaultConfig()));
  await writeIfMissing(
    join(cwd, "AGENTS.md"),
    `# Project Instructions\n\nThis file is project-local context for GAIA agents.\n\nAdd repo conventions, commands, constraints, and preferences here.\nCanonical agent identity lives in global personas under ~/.gaia/agents/.\n`,
  );
  await ensureWorkspaceRoom(cwd, DEFAULT_ROOM);

  return { workspaceDir, globalAgentsDir: agentsDir };
}

export async function loadWorkspace(cwd: string): Promise<Workspace> {
  const dir = workspacePath(cwd);
  if (!existsSync(dir)) throw new Error(`Missing ${WORKSPACE_DIRNAME} workspace. Run \`gaia init\` first.`);

  const configPath = workspaceFile(cwd, "config.json");
  const agentsOverrideDir = workspaceFile(cwd, "agents");
  const roomsDir = workspaceFile(cwd, "rooms");
  const globalAgentsDir = globalAgentsPath();

  if (!existsSync(configPath)) throw new Error(`Missing workspace config: ${configPath}`);

  await ensureGlobalDefaultAgents(globalAgentsDir);

  const config = mergeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const contextFiles = await discoverContextFiles(cwd);
  const agents = await loadAgentDefinitions(globalAgentsDir, agentsOverrideDir);

  if (!agents[config.defaultAgent]) {
    throw new Error(`Default agent not found: ${config.defaultAgent}`);
  }

  await ensureWorkspaceRoom(cwd, config.room);

  return {
    rootDir: cwd,
    dir,
    configPath,
    agentsOverrideDir,
    roomsDir,
    globalAgentsDir,
    config,
    contextFiles,
    agents,
  };
}
