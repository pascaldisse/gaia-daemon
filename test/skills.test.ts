import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSkillNames, discoverSkills, resolveSkillRefs } from "../src/domain/skills.js";
import { skillHintOptions } from "../src/services/hints.js";
import type { AgentDef } from "../src/core/types.js";
import type { ResolvedRole } from "../src/domain/roles.js";

async function writeSkill(root: string, dir: string, name: string, description = "d"): Promise<void> {
  const skillDir = join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody of ${name}\n`);
}
async function fixtureHomes(): Promise<{ workspace: { dir: string }; gaiaHome: string; userHome: string }> {
  const base = await mkdtemp(join(tmpdir(), "gaia-skills-"));
  const workspaceDir = join(base, "ws");
  const gaiaHome = join(base, "gaia");
  const userHome = join(base, "home");
  await writeSkill(join(gaiaHome, "skills"), "matriarch", "matriarch");
  await writeSkill(join(userHome, ".pi", "agent", "skills", "pi-skills"), "brave-search", "brave-search", "web search");
  await writeSkill(join(userHome, ".hermes", "skills"), "obsidian", "obsidian");
  return { workspace: { dir: workspaceDir }, gaiaHome, userHome };
}

test("discoverSkills detects project, global, Pi, and Hermes skills", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  const byName = new Map(discoverSkills(workspace, gaiaHome, userHome).map((skill) => [skill.name, skill]));
  assert.equal(byName.get("matriarch")?.source, "global");
  assert.equal(byName.get("brave-search")?.source, "pi");
  assert.equal(byName.get("obsidian")?.source, "hermes");
});

test("resolveSkillRefs and hints retain Pi skills", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  process.env.GAIA_HOME = gaiaHome;
  process.env.HOME = userHome;
  const result = resolveSkillRefs(workspace, ["brave-search", "does-not-exist"]);
  assert.deepEqual(result.skills.map((skill) => skill.name), ["brave-search"]);
  assert.ok(result.diagnostics.some((line) => /Unknown skill/.test(line)));
  const options = skillHintOptions(workspace);
  assert.equal(options.find((option) => option.value === "brave-search")?.group, "pi");
});

test("agentSkillNames uses role defaults unless explicitly overridden", () => {
  const role = { skills: ["brave-search", "shared"] } as unknown as ResolvedRole;
  const agent = { skills: ["shared", "browser-tools"] } as unknown as AgentDef;
  assert.deepEqual(agentSkillNames(agent, role), ["brave-search", "shared"]);
  assert.deepEqual(agentSkillNames({ ...agent, skillOverride: ["browser-tools"] }, role), ["browser-tools"]);
});
