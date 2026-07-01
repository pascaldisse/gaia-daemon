// Roles: named prompt overlays under persona/roles/<name>.md, with optional
// YAML frontmatter declaring skills. A project role file with the same name
// is appended after the global one, never replacing it.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentDef } from "../core/types.js";
import { readText } from "../core/store.js";

export interface RoleFile {
  path: string;
  body: string;
  skills: string[];
  diagnostics: string[];
}

export interface ResolvedRole {
  name: string;
  prompt: string;
  skills: string[];
  diagnostics: string[];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseRoleMarkdown(content: string, path = "<role>"): Omit<RoleFile, "path"> {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { body: content, skills: [], diagnostics: [`Malformed role frontmatter in ${path}: ${reason}`] };
  }

  const diagnostics: string[] = [];
  const skills: string[] = [];
  if (frontmatter.skills !== undefined) {
    if (!Array.isArray(frontmatter.skills)) {
      diagnostics.push(`Malformed skills declaration in ${path}: expected a list`);
    } else {
      for (const skill of frontmatter.skills) {
        if (typeof skill === "string" && skill.trim()) skills.push(skill.trim());
        else diagnostics.push(`Malformed skills item in ${path}: ${JSON.stringify(skill)}`);
      }
    }
  }

  return { body, skills: dedupe(skills), diagnostics };
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
  return dedupe([...(await roleNamesInDir(agent.rolesDir)), ...(await roleNamesInDir(agent.projectRolesDir))]).sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function resolveAgentRole(agent: AgentDef, name: string): Promise<ResolvedRole | undefined> {
  if (!isRoleName(name)) return undefined;

  const globalPath = rolePath(agent.rolesDir, name);
  const projectPath = rolePath(agent.projectRolesDir, name);
  const globalFile = globalPath && existsSync(globalPath) ? await readRoleFile(globalPath) : undefined;
  const projectFile = projectPath && existsSync(projectPath) ? await readRoleFile(projectPath) : undefined;

  if (!globalFile && !projectFile) return undefined;

  const promptParts = [globalFile?.body.trim(), projectFile?.body.trim()].filter((part): part is string => Boolean(part));

  return {
    name,
    prompt: promptParts.join("\n\n"),
    skills: dedupe([...(globalFile?.skills ?? []), ...(projectFile?.skills ?? [])]),
    diagnostics: [...(globalFile?.diagnostics ?? []), ...(projectFile?.diagnostics ?? [])],
  };
}
