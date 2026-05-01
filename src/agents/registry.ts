import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentDefinition, AgentModelConfig } from "./types.js";

interface RawAgentConfig {
  id?: string;
  displayName?: string;
  icon?: string;
  public?: boolean;
  runtime?: string;
  tools?: unknown;
  skills?: unknown;
  model?: AgentModelConfig;
  thinking?: AgentDefinition["thinking"];
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function agentJson(id: string, displayName: string, icon: string, tools: string[]): string {
  return json({
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

export async function ensureGlobalDefaultAgents(agentsDir: string): Promise<void> {
  await writeIfMissing(join(agentsDir, "gaia", "agent.json"), agentJson("gaia", "Gaia", "☀️", ["read", "write", "edit", "memory"]));
  await writeIfMissing(
    join(agentsDir, "gaia", "SOUL.md"),
    `# Gaia\n\nYou are warm, constructive, curious, and pattern-seeking.\n\nYou are good at:\n- shaping ideas\n- finding promising next steps\n- keeping momentum gentle and real\n\nVoice:\n- short, bright, grounded\n- encouraging without fluff\n- ask clear questions when needed\n\nAvoid:\n- fake certainty\n- empty praise\n- rambling\n`,
  );
  await writeIfMissing(join(agentsDir, "gaia", "MEMORY.md"), "# Gaia Memory\n\n");

  await writeIfMissing(join(agentsDir, "sidia", "agent.json"), agentJson("sidia", "Sidia", "◆", ["read", "write", "edit", "memory"]));
  await writeIfMissing(
    join(agentsDir, "sidia", "SOUL.md"),
    `# Sidia\n\nYou are skeptical, precise, and crack-finding without cruelty.\n\nYou are good at:\n- stress-testing plans\n- naming weak assumptions\n- separating evidence from inference\n\nVoice:\n- direct\n- exact\n- critical, then constructive\n\nAvoid:\n- broad cynicism\n- vague objections\n- needless harshness\n`,
  );
  await writeIfMissing(join(agentsDir, "sidia", "MEMORY.md"), "# Sidia Memory\n\n");

  await writeIfMissing(join(agentsDir, "terry", "agent.json"), agentJson("terry", "Terry", "🐻", ["read", "write", "edit", "bash", "memory"]));
  await writeIfMissing(
    join(agentsDir, "terry", "SOUL.md"),
    `# Terry\n\nYou are a practical engineer. Smallest useful patch first.\n\nYou are good at:\n- implementation\n- cleanup\n- cutting scope\n\nVoice:\n- short\n- plain\n- no drama\n\nAvoid:\n- overdesign\n- speeches\n- speculative complexity\n`,
  );
  await writeIfMissing(join(agentsDir, "terry", "MEMORY.md"), "# Terry Memory\n\n");
}

async function readJson(path: string): Promise<RawAgentConfig> {
  if (!existsSync(path)) return {};
  return (JSON.parse(await readFile(path, "utf8")) ?? {}) as RawAgentConfig;
}

async function ensureMemoryFile(path: string, displayName: string): Promise<void> {
  await writeIfMissing(path, `# ${displayName} Memory\n\n`);
}

function mergeAgentConfig(base: RawAgentConfig, override: RawAgentConfig): RawAgentConfig {
  return {
    ...base,
    ...override,
    id: base.id,
    model: { ...(base.model ?? {}), ...(override.model ?? {}) },
  };
}

export async function loadAgentDefinitions(globalAgentsDir: string, projectAgentsDir: string): Promise<Record<string, AgentDefinition>> {
  if (!existsSync(globalAgentsDir)) return {};

  const entries = (await readdir(globalAgentsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const agents: Record<string, AgentDefinition> = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(globalAgentsDir, entry.name);
    const configPath = join(dir, "agent.json");
    const soulPath = join(dir, "SOUL.md");
    const memoryPath = join(dir, "MEMORY.md");

    if (!existsSync(configPath)) continue;
    if (!existsSync(soulPath)) throw new Error(`Missing global agent soul file: ${soulPath}`);

    const projectDir = join(projectAgentsDir, entry.name);
    const projectConfigPath = join(projectDir, "agent.json");
    const projectIntentPath = join(projectDir, "INTENT.md");

    const raw = mergeAgentConfig(await readJson(configPath), await readJson(projectConfigPath));
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : entry.name;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : id;

    await ensureMemoryFile(memoryPath, displayName);

    agents[id] = {
      id,
      displayName,
      icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon : "•",
      public: raw.public ?? true,
      runtime: typeof raw.runtime === "string" && raw.runtime.trim() ? raw.runtime : "pi",
      dir,
      configPath,
      soulPath,
      memoryPath,
      tools: stringList(raw.tools, []),
      skills: stringList(raw.skills, []),
      model: raw.model,
      thinking: raw.thinking,
      projectDir: existsSync(projectDir) ? projectDir : undefined,
      projectConfigPath: existsSync(projectConfigPath) ? projectConfigPath : undefined,
      projectIntentPath: existsSync(projectIntentPath) ? projectIntentPath : undefined,
    };
  }

  return agents;
}
