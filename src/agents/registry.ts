import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { jsonText, readJsonFile, writeIfMissing } from "../lib/fs.js";
import { agentConfigTemplate } from "./scaffold.js";
import type { AgentDefinition, AgentModelConfig } from "./types.js";

interface RawAgentConfig {
  id?: string;
  displayName?: string;
  icon?: string;
  voice?: unknown;
  tools?: unknown;
  model?: AgentModelConfig;
  thinking?: AgentDefinition["thinking"];
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

async function mkdirIfMissing(path: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(path, { recursive: true });
}

// Pre-release layouts kept persona files at the agent root. Move them into
// persona/ once; after this every code path knows a single layout.
async function migrateLegacyPersonaFiles(dir: string, names: string[]): Promise<void> {
  const personaDir = join(dir, "persona");
  for (const name of names) {
    const legacyPath = join(dir, name);
    const newPath = join(personaDir, name);
    if (!existsSync(legacyPath) || existsSync(newPath)) continue;
    await mkdir(personaDir, { recursive: true });
    await rename(legacyPath, newPath);
  }
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

  await migrateLegacyPersonaFiles(dir, ["SOUL.md", "MEMORY.md"]);
  await writeIfMissing(join(dir, "agent.json"), jsonText(agentConfigTemplate(id, displayName, icon, tools)));
  await writeIfMissing(join(personaDir, "SOUL.md"), soul);
  await writeIfMissing(join(personaDir, "MEMORY.md"), `# ${displayName} Memory\n\n`);
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

async function readAgentConfig(path: string): Promise<RawAgentConfig> {
  return ((await readJsonFile(path)) ?? {}) as RawAgentConfig;
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
    if (!existsSync(configPath)) continue;

    await migrateLegacyPersonaFiles(dir, ["SOUL.md", "MEMORY.md"]);
    const personaDir = join(dir, "persona");
    const rolesDir = join(personaDir, "roles");
    const soulPath = join(personaDir, "SOUL.md");
    const memoryPath = join(personaDir, "MEMORY.md");
    if (!existsSync(soulPath)) throw new Error(`Missing global agent soul file: ${soulPath}`);

    const projectDir = join(projectAgentsDir, entry.name);
    if (existsSync(projectDir)) await migrateLegacyPersonaFiles(projectDir, ["INTENT.md"]);
    const projectPersonaDir = join(projectDir, "persona");
    const projectConfigPath = join(projectDir, "agent.json");
    const projectIntentPath = join(projectPersonaDir, "INTENT.md");
    const projectRolesDir = join(projectPersonaDir, "roles");

    const raw = mergeAgentConfig(await readAgentConfig(configPath), await readAgentConfig(projectConfigPath));
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : entry.name;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : id;

    await mkdirIfMissing(rolesDir);

    agents[id] = {
      id,
      displayName,
      icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon : "•",
      voice: typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : undefined,
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
      projectIntentPath: existsSync(projectIntentPath) ? projectIntentPath : undefined,
    };
  }

  return agents;
}
