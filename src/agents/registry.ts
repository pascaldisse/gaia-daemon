import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentDefinition, AgentModelConfig } from "./types.js";

interface RawAgentConfig {
  id?: string;
  displayName?: string;
  icon?: string;
  voice?: unknown;
  runtime?: string;
  tools?: unknown;
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

async function mkdirIfMissing(path: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(path, { recursive: true });
}

async function writePersonaFileIfMissing(newPath: string, legacyPath: string, content: string): Promise<void> {
  if (existsSync(newPath) || existsSync(legacyPath)) return;
  await writeIfMissing(newPath, content);
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function agentJson(id: string, displayName: string, icon: string, tools: string[]): string {
  return json({
    id,
    displayName,
    icon,
    runtime: "pi",
    thinking: "medium",
    tools,
  });
}

async function ensureDefaultAgent(
  agentsDir: string,
  id: string,
  displayName: string,
  icon: string,
  tools: string[],
  soul: string,
): Promise<void> {
  const dir = join(agentsDir, id);
  const personaDir = join(dir, "persona");
  const legacySoulPath = join(dir, "SOUL.md");
  const legacyMemoryPath = join(dir, "MEMORY.md");

  await writeIfMissing(join(dir, "agent.json"), agentJson(id, displayName, icon, tools));
  await writePersonaFileIfMissing(join(personaDir, "SOUL.md"), legacySoulPath, soul);
  await writePersonaFileIfMissing(join(personaDir, "MEMORY.md"), legacyMemoryPath, `# ${displayName} Memory\n\n`);
  await mkdirIfMissing(join(personaDir, "roles"));
}

export async function ensureGlobalDefaultAgents(agentsDir: string): Promise<void> {
  await ensureDefaultAgent(
    agentsDir,
    "gaia",
    "Gaia",
    "☀️",
    ["read", "write", "edit", "memory"],
    `# Gaia\n\nYou are warm, constructive, curious, and pattern-seeking.\n\nYou are good at:\n- shaping ideas\n- finding promising next steps\n- keeping momentum gentle and real\n\nVoice:\n- short, bright, grounded\n- encouraging without fluff\n- ask clear questions when needed\n\nAvoid:\n- fake certainty\n- empty praise\n- rambling\n`,
  );

  await ensureDefaultAgent(
    agentsDir,
    "sidia",
    "Sidia",
    "◆",
    ["read", "write", "edit", "memory"],
    `# Sidia\n\nYou are skeptical, precise, and crack-finding without cruelty.\n\nYou are good at:\n- stress-testing plans\n- naming weak assumptions\n- separating evidence from inference\n\nVoice:\n- direct\n- exact\n- critical, then constructive\n\nAvoid:\n- broad cynicism\n- vague objections\n- needless harshness\n`,
  );

  await ensureDefaultAgent(
    agentsDir,
    "terry",
    "Terry",
    "🐻",
    ["read", "write", "edit", "bash", "memory"],
    `# Terry\n\nYou are a practical engineer. Smallest useful patch first.\n\nYou are good at:\n- implementation\n- cleanup\n- cutting scope\n\nVoice:\n- short\n- plain\n- no drama\n\nAvoid:\n- overdesign\n- speeches\n- speculative complexity\n`,
  );
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
    const personaDir = join(dir, "persona");
    const rolesDir = join(personaDir, "roles");
    const soulPath = firstExisting([join(personaDir, "SOUL.md"), join(dir, "SOUL.md")]);
    const memoryPath = firstExisting([join(personaDir, "MEMORY.md"), join(dir, "MEMORY.md")]) ?? join(personaDir, "MEMORY.md");

    if (!existsSync(configPath)) continue;
    if (!soulPath) throw new Error(`Missing global agent soul file: ${join(personaDir, "SOUL.md")}`);

    const projectDir = join(projectAgentsDir, entry.name);
    const projectPersonaDir = join(projectDir, "persona");
    const projectConfigPath = join(projectDir, "agent.json");
    const projectIntentPath = firstExisting([join(projectPersonaDir, "INTENT.md"), join(projectDir, "INTENT.md")]);
    const projectRolesDir = join(projectPersonaDir, "roles");

    const raw = mergeAgentConfig(await readJson(configPath), await readJson(projectConfigPath));
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : entry.name;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : id;

    await ensureMemoryFile(memoryPath, displayName);
    await mkdirIfMissing(rolesDir);

    agents[id] = {
      id,
      displayName,
      icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon : "•",
      voice: typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : undefined,
      runtime: typeof raw.runtime === "string" && raw.runtime.trim() ? raw.runtime : "pi",
      dir,
      configPath,
      personaDir,
      rolesDir,
      soulPath,
      memoryPath,
      tools: stringList(raw.tools, []),
      model: raw.model,
      thinking: raw.thinking,
      projectDir: existsSync(projectDir) ? projectDir : undefined,
      projectConfigPath: existsSync(projectConfigPath) ? projectConfigPath : undefined,
      projectPersonaDir: existsSync(projectPersonaDir) ? projectPersonaDir : undefined,
      projectRolesDir: existsSync(projectRolesDir) ? projectRolesDir : undefined,
      projectIntentPath,
    };
  }

  return agents;
}
