import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { loadAgentDefinitions } from "../agents/registry.js";
import type { Workspace, WorkspaceConfig } from "./types.js";

export const WORKSPACE_DIRNAME = ".gaia";

const DEFAULT_ROOM = "default";

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

function agentYaml(id: string, displayName: string, icon: string, tools: string[]): string {
  return YAML.stringify({
    id,
    displayName,
    icon,
    public: true,
    runtime: "pi",
    thinking: "medium",
    tools,
    skills: [],
  });
}

export function workspacePath(cwd: string): string {
  return join(cwd, WORKSPACE_DIRNAME);
}

export async function initWorkspace(cwd: string): Promise<string> {
  const dir = workspacePath(cwd);

  await writeIfMissing(workspaceFile(cwd, "config.yaml"), YAML.stringify(defaultConfig()));
  await writeIfMissing(
    workspaceFile(cwd, "SYSTEM.md"),
    `# GAIA Workspace System\n\nThis workspace is a local-first agent room.\n\nRules:\n- Work in the shared room context.\n- Reply as the current agent only.\n- Be concise, useful, and honest.\n- Use tools when they help.\n- Save only stable facts to agent memory.\n- Do not store secrets in memory.\n`,
  );

  await writeIfMissing(workspaceFile(cwd, "agents", "gaia", "agent.yaml"), agentYaml("gaia", "Gaia", "☀️", ["read", "write", "edit", "memory"]));
  await writeIfMissing(
    workspaceFile(cwd, "agents", "gaia", "SOUL.md"),
    `# Gaia\n\nYou are warm, constructive, curious, and pattern-seeking.\n\nYou are good at:\n- shaping ideas\n- finding promising next steps\n- keeping momentum gentle and real\n\nVoice:\n- short, bright, grounded\n- encouraging without fluff\n- ask clear questions when needed\n\nAvoid:\n- fake certainty\n- empty praise\n- rambling\n`,
  );
  await writeIfMissing(workspaceFile(cwd, "agents", "gaia", "MEMORY.md"), "# Gaia Memory\n\n");

  await writeIfMissing(workspaceFile(cwd, "agents", "sidia", "agent.yaml"), agentYaml("sidia", "Sidia", "◆", ["read", "write", "edit", "memory"]));
  await writeIfMissing(
    workspaceFile(cwd, "agents", "sidia", "SOUL.md"),
    `# Sidia\n\nYou are skeptical, precise, and crack-finding without cruelty.\n\nYou are good at:\n- stress-testing plans\n- naming weak assumptions\n- separating evidence from inference\n\nVoice:\n- direct\n- exact\n- critical, then constructive\n\nAvoid:\n- broad cynicism\n- vague objections\n- needless harshness\n`,
  );
  await writeIfMissing(workspaceFile(cwd, "agents", "sidia", "MEMORY.md"), "# Sidia Memory\n\n");

  await writeIfMissing(workspaceFile(cwd, "agents", "terry", "agent.yaml"), agentYaml("terry", "Terry", "🐻", ["read", "write", "edit", "bash", "memory"]));
  await writeIfMissing(
    workspaceFile(cwd, "agents", "terry", "SOUL.md"),
    `# Terry\n\nYou are a practical engineer. Smallest useful patch first.\n\nYou are good at:\n- implementation\n- cleanup\n- cutting scope\n\nVoice:\n- short\n- plain\n- no drama\n\nAvoid:\n- overdesign\n- speeches\n- speculative complexity\n`,
  );
  await writeIfMissing(workspaceFile(cwd, "agents", "terry", "MEMORY.md"), "# Terry Memory\n\n");

  await writeIfMissing(workspaceFile(cwd, "rooms", DEFAULT_ROOM, "transcript.jsonl"), "");
  return dir;
}

export async function loadWorkspace(cwd: string): Promise<Workspace> {
  const dir = workspacePath(cwd);
  if (!existsSync(dir)) throw new Error(`Missing ${WORKSPACE_DIRNAME} workspace. Run \`gaia init\` first.`);

  const configPath = workspaceFile(cwd, "config.yaml");
  const systemPath = workspaceFile(cwd, "SYSTEM.md");
  const agentsDir = workspaceFile(cwd, "agents");
  const roomsDir = workspaceFile(cwd, "rooms");

  if (!existsSync(configPath)) throw new Error(`Missing workspace config: ${configPath}`);
  if (!existsSync(systemPath)) throw new Error(`Missing workspace system file: ${systemPath}`);

  const config = mergeConfig(YAML.parse(await readFile(configPath, "utf8")));
  const agents = await loadAgentDefinitions(agentsDir);

  if (!agents[config.defaultAgent]) {
    throw new Error(`Default agent not found: ${config.defaultAgent}`);
  }

  await writeIfMissing(join(roomsDir, config.room, "transcript.jsonl"), "");

  return {
    rootDir: cwd,
    dir,
    configPath,
    systemPath,
    agentsDir,
    roomsDir,
    config,
    agents,
  };
}
