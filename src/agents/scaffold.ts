import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonText } from "../lib/fs.js";
import { MemoryStore } from "../memory/memory-store.js";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "./types.js";

export interface AgentScaffoldOptions {
  displayName?: string;
  icon?: string;
  tools?: string[];
}

export interface AgentScaffoldResult {
  agentDir: string;
  configPath: string;
  soulPath: string;
  memoryDir: string;
  rolesDir: string;
  /** Always empty: roles are user-added only. */
  rolePaths: [];
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assertSafeAgentId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid agent id: ${id}. Use letters, numbers, dash, or underscore.`);
}

/** The default agent.json shape, shared by `gaia agent create` and the seeded default agents. */
export function agentConfigTemplate(id: string, displayName: string, icon: string, tools: string[]): Record<string, unknown> {
  return {
    id,
    displayName,
    icon,
    thinking: "medium",
    tools,
    harness: "pi",
    model: { provider: "deepseek", name: "deepseek-v4-pro" },
  };
}

/** Returns whether a string value matches a known harness identifier. */
export function normalizeHarness(raw: unknown): "pi" | "codex" | "claude" | undefined {
  if (raw === "pi" || raw === "codex" || raw === "claude") return raw;
  return undefined;
}

/** Returns the value if it is a known Claude permission mode, else undefined. */
export function normalizePermissionMode(raw: unknown): ClaudePermissionMode | undefined {
  return typeof raw === "string" && (CLAUDE_PERMISSION_MODES as string[]).includes(raw)
    ? (raw as ClaudePermissionMode)
    : undefined;
}

export async function scaffoldGlobalAgent(globalAgentsDir: string, id: string, options: AgentScaffoldOptions = {}): Promise<AgentScaffoldResult> {
  assertSafeAgentId(id);

  const agentDir = join(globalAgentsDir, id);
  if (existsSync(agentDir)) throw new Error(`Agent already exists: ${agentDir}`);

  const displayName = options.displayName?.trim() || titleCase(id) || id;
  const icon = options.icon?.trim() || "•";
  const tools = options.tools ?? ["read", "write", "edit", "memory", "recall"];
  const personaDir = join(agentDir, "persona");
  const rolesDir = join(personaDir, "roles");
  const configPath = join(agentDir, "agent.json");
  const soulPath = join(personaDir, "SOUL.md");
  const memoryDir = join(personaDir, "memory");

  await mkdir(rolesDir, { recursive: true });
  await writeFile(configPath, jsonText(agentConfigTemplate(id, displayName, icon, tools)), "utf8");
  await writeFile(
    soulPath,
    `# ${displayName}\n\nDescribe who this agent is.\n\nVoice:\n- clear\n- useful\n- distinct\n\nBoundaries:\n- say when unsure\n- ask before risky changes\n`,
    "utf8",
  );
  await new MemoryStore().init(memoryDir, displayName);

  // Roles are user-added only; the scaffold leaves the roles directory empty.
  return { agentDir, configPath, soulPath, memoryDir, rolesDir, rolePaths: [] };
}
