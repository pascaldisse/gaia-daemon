import { existsSync } from "node:fs";
import { join } from "node:path";
import { gaiaHome } from "../workspace/workspace-loader.js";
import type { Workspace } from "../workspace/types.js";

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

  for (const name of dedupeInOrder(skillNames)) {
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
