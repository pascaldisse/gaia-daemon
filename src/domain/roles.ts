// Roles: named prompt overlays with optional YAML defaults. Shared roles under
// ~/.gaia/roles apply to every agent; agent-local and project files layer on
// top. Tools and skills are defaults only: explicit agent.json settings win,
// so the Settings checkboxes always remain an individual override surface.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../core/types.js";
import { globalPaths } from "../core/paths.js";
import { readText } from "../core/store.js";

export interface RoleFile {
  path: string;
  body: string;
  tools?: string[];
  skills?: string[];
  watchdog?: { toolCalls: number; message: string };
  diagnostics: string[];
}

export interface ResolvedRole {
  name: string;
  prompt: string;
  tools?: string[];
  skills?: string[];
  watchdog?: { toolCalls: number; message: string };
  diagnostics: string[];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function optionalStringList(value: unknown, field: string, path: string, diagnostics: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push(`Malformed ${field} declaration in ${path}: expected a list`);
    return undefined;
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) values.push(item.trim());
    else diagnostics.push(`Malformed ${field} item in ${path}: ${JSON.stringify(item)}`);
  }
  return dedupe(values);
}

export function parseRoleMarkdown(content: string, path = "<role>"): Omit<RoleFile, "path"> {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { body: content, diagnostics: [`Malformed role frontmatter in ${path}: ${reason}`] };
  }

  const diagnostics: string[] = [];
  const tools = optionalStringList(frontmatter.tools, "tools", path, diagnostics);
  const skills = optionalStringList(frontmatter.skills, "skills", path, diagnostics);

  let watchdog: { toolCalls: number; message: string } | undefined;
  if (frontmatter.watchdog !== undefined) {
    const raw = frontmatter.watchdog;
    const toolCalls = raw && typeof raw === "object" ? (raw as Record<string, unknown>).toolCalls : undefined;
    const message = raw && typeof raw === "object" ? (raw as Record<string, unknown>).message : undefined;
    const validToolCalls = typeof toolCalls === "number" && Number.isFinite(toolCalls) && Math.floor(toolCalls) > 0;
    const validMessage = typeof message === "string" && message.trim().length > 0;
    if (raw && typeof raw === "object" && validToolCalls && validMessage) {
      watchdog = { toolCalls: Math.floor(toolCalls as number), message: message as string };
    } else {
      diagnostics.push(`Malformed watchdog declaration in ${path}: expected { toolCalls: positive integer, message: non-empty string }`);
    }
  }

  return { body, ...(tools ? { tools } : {}), ...(skills ? { skills } : {}), ...(watchdog ? { watchdog } : {}), diagnostics };
}

async function readRoleFile(path: string): Promise<RoleFile> {
  const parsed = parseRoleMarkdown((await readText(path)) ?? "", path);
  return { path, ...parsed };
}

function isRoleName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function rolePath(dir: string | undefined, name: string): string | undefined {
  if (!dir || !isRoleName(name)) return undefined;
  return join(dir, `${name}.md`);
}

async function roleNamesInDir(dir: string | undefined): Promise<string[]> {
  if (!dir || !existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => basename(entry.name, ".md"))
    .filter(isRoleName);
}

export async function listAgentRoles(agent: AgentDef): Promise<string[]> {
  return dedupe([...(await roleNamesInDir(globalPaths.rolesDir())), ...(await roleNamesInDir(agent.rolesDir)), ...(await roleNamesInDir(agent.projectRolesDir))]).sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function resolveAgentRole(agent: AgentDef, name: string): Promise<ResolvedRole | undefined> {
  if (!isRoleName(name)) return undefined;

  const sharedPath = rolePath(globalPaths.rolesDir(), name);
  const globalPath = rolePath(agent.rolesDir, name);
  const projectPath = rolePath(agent.projectRolesDir, name);
  const sharedFile = sharedPath && existsSync(sharedPath) ? await readRoleFile(sharedPath) : undefined;
  const globalFile = globalPath && existsSync(globalPath) ? await readRoleFile(globalPath) : undefined;
  const projectFile = projectPath && existsSync(projectPath) ? await readRoleFile(projectPath) : undefined;

  if (!sharedFile && !globalFile && !projectFile) return undefined;

  const promptParts = [sharedFile?.body.trim(), globalFile?.body.trim(), projectFile?.body.trim()].filter((part): part is string => Boolean(part));

  const watchdog = projectFile?.watchdog ?? globalFile?.watchdog;
  const tools = projectFile?.tools ?? globalFile?.tools ?? sharedFile?.tools;
  const skillLayers = [sharedFile?.skills, globalFile?.skills, projectFile?.skills].filter((value): value is string[] => value !== undefined);
  const skills = skillLayers.length ? dedupe(skillLayers.flat()) : undefined;

  return {
    name,
    prompt: promptParts.join("\n\n"),
    ...(tools ? { tools } : {}),
    ...(skills ? { skills } : {}),
    ...(watchdog ? { watchdog } : {}),
    diagnostics: [...(sharedFile?.diagnostics ?? []), ...(globalFile?.diagnostics ?? []), ...(projectFile?.diagnostics ?? [])],
  };
}

/** Role defaults are always subordinate to an explicit per-agent Settings value. */
export function effectiveAgentTools(agent: Pick<AgentDef, "tools" | "toolOverride">, role: ResolvedRole | undefined): string[] {
  return [...(agent.toolOverride ?? role?.tools ?? agent.tools)];
}

export function effectiveAgentSkills(agent: Pick<AgentDef, "skills" | "skillOverride">, role: ResolvedRole | undefined): string[] {
  return [...(agent.skillOverride ?? role?.skills ?? agent.skills ?? [])];
}

/** Synchronous role-default catalog for the Settings form. It deliberately
 * reads only shared + agent-global files: project overlays are workspace-local
 * and the form is editing the global agent file. */
export function globalRoleDefaults(agentId: string): Record<string, { tools?: string[]; skills?: string[] }> {
  const dirs = [globalPaths.rolesDir(), join(globalPaths.agentDir(agentId), "persona", "roles")];
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of roleNamesInDirSync(dir)) names.add(entry);
  }
  const out: Record<string, { tools?: string[]; skills?: string[] }> = {};
  for (const name of names) {
    let tools: string[] | undefined;
    const skillLayers: string[][] = [];
    for (const dir of dirs) {
      const path = rolePath(dir, name);
      if (!path || !existsSync(path)) continue;
      const parsed = parseRoleMarkdown(readFileSync(path, "utf8"), path);
      tools = parsed.tools ?? tools;
      if (parsed.skills !== undefined) skillLayers.push(parsed.skills);
    }
    const skills = skillLayers.length ? dedupe(skillLayers.flat()) : undefined;
    if (tools || skills) out[name] = { ...(tools ? { tools } : {}), ...(skills ? { skills } : {}) };
  }
  return out;
}

function roleNamesInDirSync(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => basename(entry.name, ".md"))
      .filter(isRoleName);
  } catch {
    return [];
  }
}

// Effective role for an agent in a room: the room's activeRoles entry wins;
// the literal "none" is an explicit override to no role; an absent entry
// inherits the agent's global default (agent.json "role").
export function effectiveRoleName(activeRoles: Record<string, string>, agent: AgentDef): string | undefined {
  const entry = activeRoles[agent.id];
  if (entry === "none") return undefined;
  return entry ?? agent.defaultRole;
}
