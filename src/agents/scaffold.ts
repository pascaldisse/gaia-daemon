import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentScaffoldOptions {
  displayName?: string;
  icon?: string;
  tools?: string[];
}

export interface AgentScaffoldResult {
  agentDir: string;
  configPath: string;
  soulPath: string;
  memoryPath: string;
  rolesDir: string;
  rolePaths: string[];
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSafeAgentId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid agent id: ${id}. Use letters, numbers, dash, or underscore.`);
}

export async function scaffoldGlobalAgent(globalAgentsDir: string, id: string, options: AgentScaffoldOptions = {}): Promise<AgentScaffoldResult> {
  assertSafeAgentId(id);

  const agentDir = join(globalAgentsDir, id);
  if (existsSync(agentDir)) throw new Error(`Agent already exists: ${agentDir}`);

  const displayName = options.displayName?.trim() || titleCase(id) || id;
  const icon = options.icon?.trim() || "•";
  const tools = options.tools ?? ["read", "write", "edit", "memory"];
  const personaDir = join(agentDir, "persona");
  const rolesDir = join(personaDir, "roles");
  const configPath = join(agentDir, "agent.json");
  const soulPath = join(personaDir, "SOUL.md");
  const memoryPath = join(personaDir, "MEMORY.md");

  await mkdir(rolesDir, { recursive: true });
  await writeFile(configPath, json({ id, displayName, icon, runtime: "pi", thinking: "medium", tools }), "utf8");
  await writeFile(
    soulPath,
    `# ${displayName}\n\nDescribe who this agent is.\n\nVoice:\n- clear\n- useful\n- distinct\n\nBoundaries:\n- say when unsure\n- ask before risky changes\n`,
    "utf8",
  );
  await writeFile(memoryPath, `# ${displayName} Memory\n\n`, "utf8");

  const roles = new Map([
    [
      "brainstorm",
      `---\nskills:\n  - brainstorm\n---\n# Brainstorm Role\n\nExplore the problem space. Generate options. Notice patterns. Ask crisp questions when the goal is fuzzy.\n`,
    ],
    [
      "research",
      `---\nskills:\n  - web\n---\n# Research Role\n\nFind evidence. Separate facts from guesses. Cite uncertainty. Bring back concise findings.\n`,
    ],
    [
      "plan",
      `---\nskills:\n  - plan\n---\n# Plan Role\n\nTurn the chosen direction into ordered tasks, dependencies, risks, and acceptance criteria.\n`,
    ],
  ]);

  const rolePaths: string[] = [];
  for (const [name, content] of roles) {
    const path = join(rolesDir, `${name}.md`);
    await writeFile(path, content, "utf8");
    rolePaths.push(path);
  }

  return { agentDir, configPath, soulPath, memoryPath, rolesDir, rolePaths };
}
