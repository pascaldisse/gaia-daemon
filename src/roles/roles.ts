import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";

export interface RoleFile {
  path: string;
  body: string;
  skills: string[];
  diagnostics: string[];
}

export interface ResolvedRole {
  name: string;
  globalPath?: string;
  projectPath?: string;
  globalBody?: string;
  projectBody?: string;
  prompt: string;
  skills: string[];
  diagnostics: string[];
}

function dedupeInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseInlineSkills(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;

  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

export function parseRoleMarkdown(content: string, path = "<role>"): Omit<RoleFile, "path"> {
  const diagnostics: string[] = [];
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { body: content, skills: [], diagnostics };
  }

  const lineBreak = content.startsWith("---\r\n") ? "\r\n" : "\n";
  const startLength = `---${lineBreak}`.length;
  const closingMarker = `${lineBreak}---${lineBreak}`;
  const closingIndex = content.indexOf(closingMarker, startLength);

  if (closingIndex === -1) {
    diagnostics.push(`Malformed role frontmatter in ${path}: missing closing ---`);
    return { body: content, skills: [], diagnostics };
  }

  const frontmatter = content.slice(startLength, closingIndex);
  const body = content.slice(closingIndex + closingMarker.length);
  const lines = frontmatter.split(/\r?\n/);
  const skills: string[] = [];
  let readingSkills = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed === "skills:") {
      readingSkills = true;
      continue;
    }

    if (trimmed.startsWith("skills:")) {
      readingSkills = false;
      const parsed = parseInlineSkills(trimmed.slice("skills:".length));
      if (parsed === undefined) diagnostics.push(`Malformed skills declaration in ${path}: ${trimmed}`);
      else skills.push(...parsed);
      continue;
    }

    if (readingSkills && trimmed.startsWith("- ")) {
      const skill = trimmed.slice(2).trim().replace(/^['\"]|['\"]$/g, "");
      if (skill) skills.push(skill);
      continue;
    }

    if (readingSkills && /^[A-Za-z0-9_-]+:/.test(trimmed)) {
      readingSkills = false;
      continue;
    }

    if (readingSkills) {
      diagnostics.push(`Malformed skills item in ${path}: ${trimmed}`);
    }
  }

  return { body, skills: dedupeInOrder(skills), diagnostics };
}

async function readRoleFile(path: string): Promise<RoleFile> {
  const parsed = parseRoleMarkdown(await readFile(path, "utf8"), path);
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

export async function listAgentRoles(agent: AgentDefinition): Promise<string[]> {
  return dedupeInOrder([...(await roleNamesInDir(agent.rolesDir)), ...(await roleNamesInDir(agent.projectRolesDir))]).sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function resolveAgentRole(agent: AgentDefinition, name: string): Promise<ResolvedRole | undefined> {
  if (!isRoleName(name)) return undefined;

  const globalPath = rolePath(agent.rolesDir, name);
  const projectPath = rolePath(agent.projectRolesDir, name);
  const globalFile = globalPath && existsSync(globalPath) ? await readRoleFile(globalPath) : undefined;
  const projectFile = projectPath && existsSync(projectPath) ? await readRoleFile(projectPath) : undefined;

  if (!globalFile && !projectFile) return undefined;

  const promptParts = [globalFile?.body.trim(), projectFile?.body.trim()].filter((part): part is string => Boolean(part));

  return {
    name,
    globalPath: globalFile?.path,
    projectPath: projectFile?.path,
    globalBody: globalFile?.body,
    projectBody: projectFile?.body,
    prompt: promptParts.join("\n\n"),
    skills: dedupeInOrder([...(globalFile?.skills ?? []), ...(projectFile?.skills ?? [])]),
    diagnostics: [...(globalFile?.diagnostics ?? []), ...(projectFile?.diagnostics ?? [])],
  };
}
