import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureGlobalDefaultAgents, loadAgentDefinitions } from "../agents/registry.js";
import { defaultRoomState } from "../room/state.js";
import { discoverContextFiles } from "./context-files.js";
import type { Workspace, WorkspaceConfig } from "./types.js";

export const WORKSPACE_DIRNAME = ".gaia";
export const DEFAULT_ROOM = "default";

export function gaiaHome(): string {
  return resolve(process.env.GAIA_HOME ?? join(homedir(), ".gaia"));
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
    runtime: "pi",
    transcriptWindow: 20,
  };
}

function mergeConfig(raw: unknown): WorkspaceConfig {
  const base = defaultConfig();
  const input = raw && typeof raw === "object" ? (raw as Partial<WorkspaceConfig>) : {};
  return {
    defaultAgent: typeof input.defaultAgent === "string" && input.defaultAgent.trim() ? input.defaultAgent : base.defaultAgent,
    room: typeof input.room === "string" && input.room.trim() ? input.room : base.room,
    runtime: typeof input.runtime === "string" && input.runtime.trim() ? input.runtime : base.runtime,
    transcriptWindow:
      typeof input.transcriptWindow === "number" && Number.isFinite(input.transcriptWindow) && input.transcriptWindow > 0
        ? Math.floor(input.transcriptWindow)
        : base.transcriptWindow,
  };
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function workspacePath(cwd: string): string {
  return join(cwd, WORKSPACE_DIRNAME);
}

export async function initWorkspace(cwd: string): Promise<{ workspaceDir: string; globalAgentsDir: string }> {
  const workspaceDir = workspacePath(cwd);
  const agentsDir = globalAgentsPath();

  await ensureGlobalDefaultAgents(agentsDir);
  await writeIfMissing(workspaceFile(cwd, "config.json"), json(defaultConfig()));
  await writeIfMissing(
    join(cwd, "AGENTS.md"),
    `# Project Instructions\n\nThis file is project-local context for GAIA agents.\n\nAdd repo conventions, commands, constraints, and preferences here.\nCanonical agent identity lives in global personas under ~/.gaia/agents/.\n`,
  );
  await writeIfMissing(workspaceFile(cwd, "rooms", DEFAULT_ROOM, "transcript.jsonl"), "");
  await writeIfMissing(workspaceFile(cwd, "rooms", DEFAULT_ROOM, "state.json"), json(defaultRoomState()));

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

  await writeIfMissing(join(roomsDir, config.room, "transcript.jsonl"), "");
  await writeIfMissing(join(roomsDir, config.room, "state.json"), json(defaultRoomState()));

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
