// Skill references resolve project-first (.gaia/skills/<name>/SKILL.md), then
// global (~/.gaia/skills/<name>/SKILL.md). Unsafe or unknown names degrade to
// diagnostics, never errors.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { Workspace } from "../core/types.js";
import { gaiaHome } from "../core/paths.js";
import type { ResolvedRole } from "./roles.js";

export interface ResolvedSkill {
  name: string;
  path: string;
  source: "project" | "global";
}

export interface SkillResolutionResult {
  skills: ResolvedSkill[];
  paths: string[];
  diagnostics: string[];
}

function isSkillName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function globalSkillsPath(home = gaiaHome()): string {
  return join(home, "skills");
}

export function projectSkillsPath(workspace: Pick<Workspace, "dir">): string {
  return join(workspace.dir, "skills");
}

function skillFilePath(root: string, name: string): string {
  return join(root, name, "SKILL.md");
}

export function resolveSkillRefs(workspace: Pick<Workspace, "dir">, skillNames: string[], home = gaiaHome()): SkillResolutionResult {
  const diagnostics: string[] = [];
  const skills: ResolvedSkill[] = [];

  for (const name of new Set(skillNames)) {
    if (!isSkillName(name)) {
      diagnostics.push(`Ignoring unsafe skill name: ${name}`);
      continue;
    }

    const projectPath = skillFilePath(projectSkillsPath(workspace), name);
    if (existsSync(projectPath)) {
      skills.push({ name, path: projectPath, source: "project" });
      continue;
    }

    const globalPath = skillFilePath(globalSkillsPath(home), name);
    if (existsSync(globalPath)) {
      skills.push({ name, path: globalPath, source: "global" });
      continue;
    }

    diagnostics.push(`Unknown skill: ${name}`);
  }

  return {
    skills,
    paths: skills.map((skill) => skill.path),
    diagnostics,
  };
}

/**
 * Inline the text of a role's skills for harnesses that can't load skill files
 * natively. Pi loads skills via the SDK (additionalSkillPaths); the Claude and
 * Codex harnesses run external CLIs that never see them, so we read each
 * SKILL.md, strip its frontmatter, and return a block to append to the system
 * prompt. Without this, a role that references a skill (e.g. matriarch) reaches
 * those agents as an instruction to use a skill they can't see.
 */
export async function loadRoleSkillText(
  workspace: Pick<Workspace, "dir">,
  role: ResolvedRole | undefined,
  home = gaiaHome(),
): Promise<{ text: string; diagnostics: string[] }> {
  if (!role || role.skills.length === 0) return { text: "", diagnostics: [] };
  const resolution = resolveSkillRefs(workspace, role.skills, home);
  const blocks: string[] = [];
  for (const skill of resolution.skills) {
    try {
      const raw = await readFile(skill.path, "utf8");
      let body = raw;
      try {
        body = parseFrontmatter(raw).body;
      } catch {
        // Malformed frontmatter: fall back to the raw file.
      }
      blocks.push(`## Skill: ${skill.name}\n\n${body.trim()}`);
    } catch (error) {
      resolution.diagnostics.push(`Failed to read skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const text = blocks.length ? `# Active Role Skills\n\n${blocks.join("\n\n")}` : "";
  return { text, diagnostics: resolution.diagnostics };
}
