// Skills are AUTO-DETECTED (never auto-loaded) by scanning every install
// location and keying each by its SKILL.md frontmatter `name`:
//   1. project  — <workspace>/skills/<name>/SKILL.md
//   2. global   — ~/.gaia/skills/<name>/SKILL.md
//   3. pi       — ~/.pi/agent/skills/**/SKILL.md  (pi's own library; nested one
//                 level under collection dirs like pi-skills/, so name != dir)
// Earlier sources win, so a project skill overrides a same-named pi skill.
// Which detected skills actually load is set per agent/persona/role (config),
// not here. Unsafe/unknown names degrade to diagnostics, never errors.

import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDef, Workspace } from "../core/types.js";
import { globalPaths, workspacePaths } from "../core/paths.js";
import type { ResolvedRole } from "./roles.js";

// The install location a skill was detected in. Known ecosystems are spelled
// out for autocomplete; the `(string & {})` arm keeps it open for new roots.
export type SkillSource = "project" | "global" | "pi" | "claude" | "codex" | "hermes" | (string & {});

export interface ResolvedSkill {
  name: string;
  path: string;
  source: SkillSource;
  /** SKILL.md frontmatter description, when present (for UI/assignment). */
  description?: string;
}

export interface SkillResolutionResult {
  skills: ResolvedSkill[];
  paths: string[];
  diagnostics: string[];
}

function isSkillName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

// The real skill locations are defined once in core/paths.ts. `home` and a
// missing `rootDir` are injection seams: tests (and the degraded hints
// fallback, which only carries a bare dir) mirror the same layout beside the
// injected dir instead of the canonical accessors.
type SkillWorkspaceRef = Pick<Workspace, "dir"> & Partial<Pick<Workspace, "rootDir">>;

export function globalSkillsPath(home?: string): string {
  return home === undefined ? globalPaths.skillsDir() : join(home, "skills");
}

export function projectSkillsPath(workspace: SkillWorkspaceRef): string {
  return workspace.rootDir === undefined ? join(workspace.dir, "skills") : workspacePaths.skillsDir(workspace.rootDir);
}

export interface SkillRoot {
  path: string;
  source: SkillSource;
}

/** Every skill directory gaia auto-detects, in precedence order (earlier wins).
 * Covers the popular agent ecosystems — pi, Claude Code, Codex, Hermes — plus
 * gaia's own. Non-existent dirs are skipped silently, so listing a tool you
 * don't use costs nothing; add a line here to cover another. A detected skill is
 * only AVAILABLE — which agent/persona/role loads it stays explicit config. */
export function skillRoots(workspace: SkillWorkspaceRef, home?: string, userHome = homedir()): SkillRoot[] {
  return [
    { path: projectSkillsPath(workspace), source: "project" },
    // Claude Code's project-level skills live beside the project ROOT
    // (<root>/.claude/skills — workspace.dir is <root>/.gaia, one level in);
    // the bare-dir seam mirrors the layout inside the injected dir as above.
    { path: join(workspace.rootDir ?? workspace.dir, ".claude", "skills"), source: "project" },
    { path: globalSkillsPath(home), source: "global" },
    { path: join(userHome, ".pi", "agent", "skills"), source: "pi" }, // pi nests under collection dirs (pi-skills/)
    { path: join(userHome, ".claude", "skills"), source: "claude" },
    { path: join(userHome, ".codex", "skills"), source: "codex" },
    { path: join(userHome, ".hermes", "skills"), source: "hermes" },
    { path: join(userHome, ".config", "hermes", "skills"), source: "hermes" },
  ];
}

// Pull `name`/`description` out of a SKILL.md's YAML frontmatter. Regex, not a
// YAML parser: the two fields are simple scalars and we must not throw on the
// malformed files that show up in a scanned tree.
function readSkillMeta(path: string): { name?: string; description?: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const field = (key: string): string | undefined => {
      const value = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
      // YAML scalars may be single/double quoted. Strip a matching wrap so a
      // quoted `name: "imagegen"` yields the bare name — otherwise it fails
      // isSkillName and the skill silently vanishes from detection.
      return value?.replace(/^(['"])([\s\S]*)\1$/, "$2");
    };
    return { name: field("name"), description: field("description") };
  } catch {
    return {};
  }
}

/** Scan a root for `<dir>/SKILL.md`, descending up to `depth` extra levels so a
 * collection dir (pi's pi-skills/) is walked into. Best-effort: an unreadable
 * dir yields nothing rather than throwing. Exported as THE one SKILL.md
 * discovery + frontmatter parser — harness command hints (claude.ts) reuse it
 * rather than re-implementing the scan/quote-strip/name rules. */
export function scanSkillRoot(root: string, source: SkillSource, depth = 1): ResolvedSkill[] {
  const found: ResolvedSkill[] = [];
  const walk = (dir: string, level: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue; // skip .git etc.
      const sub = join(dir, entry.name);
      const skillFile = join(sub, "SKILL.md");
      if (existsSync(skillFile)) {
        const meta = readSkillMeta(skillFile);
        const name = meta.name ?? entry.name;
        if (isSkillName(name)) found.push({ name, path: skillFile, source, ...(meta.description ? { description: meta.description } : {}) });
      } else if (level < depth) {
        walk(sub, level + 1); // a collection dir: look one level deeper
      }
    }
  };
  if (existsSync(root)) walk(root, 0);
  return found;
}

/** Every detected skill across all locations, keyed by name (earlier source
 * wins). This is the auto-detection surface — what's AVAILABLE to assign. */
export function discoverSkills(workspace: SkillWorkspaceRef, home?: string, userHome = homedir()): ResolvedSkill[] {
  const byName = new Map<string, ResolvedSkill>();
  for (const root of skillRoots(workspace, home, userHome)) {
    for (const skill of scanSkillRoot(root.path, root.source)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

export function resolveSkillRefs(workspace: SkillWorkspaceRef, skillNames: string[], home?: string): SkillResolutionResult {
  const registry = new Map(discoverSkills(workspace, home).map((skill) => [skill.name, skill]));
  const diagnostics: string[] = [];
  const skills: ResolvedSkill[] = [];

  for (const name of new Set(skillNames)) {
    if (!isSkillName(name)) {
      diagnostics.push(`Ignoring unsafe skill name: ${name}`);
      continue;
    }
    const found = registry.get(name);
    if (found) skills.push(found);
    else diagnostics.push(`Unknown skill: ${name}`);
  }

  return {
    skills,
    paths: skills.map((skill) => skill.path),
    diagnostics,
  };
}

/** The skills an agent loads this turn: its own plus the active role's, deduped.
 * Role and agent both opt in; detection alone never loads anything. */
export function agentSkillNames(agent: Pick<AgentDef, "skills">, role: ResolvedRole | undefined): string[] {
  return [...new Set([...(role?.skills ?? []), ...(agent.skills ?? [])])];
}

/**
 * Inline the text of named skills for harnesses that can't load skill files
 * natively. Pi loads skills via the SDK (additionalSkillPaths); the Claude and
 * Codex harnesses run external CLIs that never see them, so we read each
 * SKILL.md, strip its frontmatter, and return a block to append to the system
 * prompt. Without this, an assigned skill reaches those agents as an instruction
 * to use a skill they can't see.
 */
export async function loadSkillText(
  workspace: SkillWorkspaceRef,
  skillNames: string[],
  home?: string,
): Promise<{ text: string; diagnostics: string[] }> {
  if (skillNames.length === 0) return { text: "", diagnostics: [] };
  const resolution = resolveSkillRefs(workspace, skillNames, home);
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
  const text = blocks.length ? `# Skills\n\n${blocks.join("\n\n")}` : "";
  return { text, diagnostics: resolution.diagnostics };
}
