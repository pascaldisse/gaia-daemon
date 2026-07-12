// Roles: named prompt overlays under persona/roles/<name>.md, with optional
// YAML frontmatter declaring skills. A project role file with the same name
// is appended after the global one, never replacing it.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../core/types.js";
import { readText } from "../core/store.js";

/** `message` is used verbatim (once, or every crossing if `repeat`). `messages`
 * — a non-empty list — overrides `message` and picks one at random each time,
 * for variety on a repeating tripwire. `repeat: true` re-fires every
 * `toolCalls` calls for the rest of the turn instead of stopping after one. */
export interface RoleWatchdog {
  toolCalls: number;
  message: string;
  messages?: string[];
  repeat?: boolean;
}

export interface RoleFile {
  path: string;
  body: string;
  skills: string[];
  watchdog?: RoleWatchdog;
  diagnostics: string[];
}

export interface ResolvedRole {
  name: string;
  prompt: string;
  skills: string[];
  watchdog?: RoleWatchdog;
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

  let watchdog: RoleWatchdog | undefined;
  if (frontmatter.watchdog !== undefined) {
    const raw = frontmatter.watchdog;
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    const toolCalls = obj?.toolCalls;
    const message = obj?.message;
    const messagesRaw = obj?.messages;
    const validToolCalls = typeof toolCalls === "number" && Number.isFinite(toolCalls) && Math.floor(toolCalls) > 0;
    const validMessage = typeof message === "string" && message.trim().length > 0;
    const messages =
      Array.isArray(messagesRaw) && messagesRaw.every((m) => typeof m === "string" && m.trim().length > 0)
        ? (messagesRaw as string[])
        : undefined;
    const validMessages = messagesRaw === undefined || messages !== undefined;
    if (obj && validToolCalls && validMessage && validMessages) {
      watchdog = {
        toolCalls: Math.floor(toolCalls as number),
        message: message as string,
        ...(messages ? { messages } : {}),
        ...(obj.repeat === true ? { repeat: true } : {}),
      };
    } else {
      diagnostics.push(
        `Malformed watchdog declaration in ${path}: expected { toolCalls: positive integer, message: non-empty string, messages?: string[], repeat?: boolean }`,
      );
    }
  }

  return { body, skills: dedupe(skills), ...(watchdog ? { watchdog } : {}), diagnostics };
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

  const watchdog = projectFile?.watchdog ?? globalFile?.watchdog;

  return {
    name,
    prompt: promptParts.join("\n\n"),
    skills: dedupe([...(globalFile?.skills ?? []), ...(projectFile?.skills ?? [])]),
    ...(watchdog ? { watchdog } : {}),
    diagnostics: [...(globalFile?.diagnostics ?? []), ...(projectFile?.diagnostics ?? [])],
  };
}

// Effective role for an agent in a room: the room's activeRoles entry wins;
// the literal "none" is an explicit override to no role; an absent entry
// inherits the agent's global default (agent.json "role").
export function effectiveRoleName(activeRoles: Record<string, string>, agent: AgentDef): string | undefined {
  const entry = activeRoles[agent.id];
  if (entry === "none") return undefined;
  return entry ?? agent.defaultRole;
}
