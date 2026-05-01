import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function ensureMemoryFile(path: string, displayName: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `# ${displayName} Memory\n\n`, "utf8");
}

export async function loadAgentDefinitions(agentsDir: string): Promise<Record<string, AgentDefinition>> {
  if (!existsSync(agentsDir)) return {};

  const entries = (await readdir(agentsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const agents: Record<string, AgentDefinition> = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(agentsDir, entry.name);
    const configPath = join(dir, "agent.yaml");
    const soulPath = join(dir, "SOUL.md");
    const memoryPath = join(dir, "MEMORY.md");

    if (!existsSync(configPath)) continue;
    if (!existsSync(soulPath)) throw new Error(`Missing agent soul file: ${soulPath}`);

    const raw = (YAML.parse(await readFile(configPath, "utf8")) ?? {}) as RawAgentConfig;
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
      tools: stringList(raw.tools),
      skills: stringList(raw.skills),
      model: raw.model,
      thinking: raw.thinking,
    };
  }

  return agents;
}
