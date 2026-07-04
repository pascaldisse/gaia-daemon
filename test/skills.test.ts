// Skill auto-detection across every install location (gaia project/global, pi,
// claude, codex, hermes) + resolution by frontmatter name + per-agent/role merge.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSkillNames, discoverSkills, resolveSkillRefs } from "../src/domain/skills.js";
import type { AgentDef } from "../src/core/types.js";
import type { ResolvedRole } from "../src/domain/roles.js";

/** Write <root>/<dir>/SKILL.md with the given frontmatter name/description. */
async function writeSkill(root: string, dir: string, name: string, description = "d"): Promise<void> {
  const skillDir = join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody of ${name}\n`);
}

/** A home/userHome/workspace triple with skill fixtures in every root. */
async function fixtureHomes(): Promise<{ workspace: { dir: string }; gaiaHome: string; userHome: string }> {
  const base = await mkdtemp(join(tmpdir(), "gaia-skills-"));
  const workspaceDir = join(base, "ws");
  const gaiaHome = join(base, "gaia"); // ~/.gaia
  const userHome = join(base, "home"); // ~

  await writeSkill(join(gaiaHome, "skills"), "matriarch", "matriarch");
  // pi nests skills one level under a collection dir (pi-skills/) — name != dir.
  await writeSkill(join(userHome, ".pi", "agent", "skills", "pi-skills"), "brave-search", "brave-search", "web search");
  await writeSkill(join(userHome, ".claude", "skills"), "unity", "unity-mcp-orchestrator");
  await writeSkill(join(userHome, ".codex", "skills"), "hatch-pet", "hatch-pet");
  await writeSkill(join(userHome, ".hermes", "skills"), "obsidian", "obsidian");

  return { workspace: { dir: workspaceDir }, gaiaHome, userHome };
}

test("discoverSkills detects skills across gaia/pi/claude/codex/hermes, keyed by frontmatter name", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  const skills = discoverSkills(workspace, gaiaHome, userHome);
  const byName = new Map(skills.map((s) => [s.name, s]));

  // Every ecosystem is scanned.
  assert.equal(byName.get("matriarch")?.source, "global");
  assert.equal(byName.get("unity-mcp-orchestrator")?.source, "claude");
  assert.equal(byName.get("hatch-pet")?.source, "codex");
  assert.equal(byName.get("obsidian")?.source, "hermes");

  // Pi's nested collection dir resolves by frontmatter name, not the dir name.
  const brave = byName.get("brave-search");
  assert.equal(brave?.source, "pi");
  assert.ok(brave?.path.includes(join(".pi", "agent", "skills", "pi-skills", "brave-search")));
  assert.equal(brave?.description, "web search");
});

test("resolveSkillRefs resolves a pi skill by name and flags unknown ones", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  process.env.GAIA_HOME = gaiaHome; // resolveSkillRefs defaults home to gaiaHome(); pin it
  process.env.HOME = userHome;

  const result = resolveSkillRefs(workspace, ["brave-search", "does-not-exist"]);
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["brave-search"],
  );
  assert.ok(result.paths[0]?.endsWith(join("brave-search", "SKILL.md")));
  assert.ok(result.diagnostics.some((d) => /Unknown skill: does-not-exist/.test(d)));
});

test("agentSkillNames merges role + agent skills, deduped", () => {
  const role = { skills: ["brave-search", "shared"] } as unknown as ResolvedRole;
  const agent = { skills: ["shared", "browser-tools"] } as unknown as AgentDef;
  assert.deepEqual(agentSkillNames(agent, role), ["brave-search", "shared", "browser-tools"]);
  assert.deepEqual(agentSkillNames({ skills: undefined } as AgentDef, undefined), []);
});
