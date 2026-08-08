// Skill auto-detection across every install location (gaia project/global, pi,
// claude, codex, hermes) + resolution by frontmatter name + per-agent/role merge.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSkillNames, discoverSkills, resolveSkillRefs } from "../src/domain/skills.js";
import { skillHintOptions } from "../src/services/hints.js";
import "../src/harness/index.js"; // registers claude so native builtins (deep-research…) union in
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

test("resolveSkillRefs: a knownExternal name (fileless native builtin) is skipped silently, not 'Unknown skill'", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  process.env.GAIA_HOME = gaiaHome;
  process.env.HOME = userHome;

  // "deep-research" has no SKILL.md here — it's a claude builtin the harness runs
  // itself. Passed as knownExternal, it must NOT inline (no path) and must NOT
  // warn; a genuinely unknown name still warns.
  const result = resolveSkillRefs(workspace, ["brave-search", "deep-research", "typo-skill"], undefined, new Set(["deep-research"]));
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["brave-search"],
  );
  assert.ok(!result.diagnostics.some((d) => /deep-research/.test(d)), "known-external name must not warn");
  assert.ok(result.diagnostics.some((d) => /Unknown skill: typo-skill/.test(d)), "a real typo still warns");
});

test("skillHintOptions groups skills by ecosystem and folds native builtins in, badged", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  process.env.GAIA_HOME = gaiaHome;
  process.env.HOME = userHome;

  const options = skillHintOptions(workspace);
  const byName = new Map(options.map((option) => [option.value, option]));

  // On-disk skills carry their ecosystem as the group; ~/.gaia (source "global") reads as "gaia".
  assert.equal(byName.get("unity-mcp-orchestrator")?.group, "claude");
  assert.equal(byName.get("unity-mcp-orchestrator")?.badge, undefined);
  assert.equal(byName.get("matriarch")?.group, "gaia");
  assert.equal(byName.get("hatch-pet")?.group, "codex");
  assert.equal(byName.get("brave-search")?.group, "pi");

  // deep-research is a fileless claude builtin: folded into the claude group, tagged native.
  assert.equal(byName.get("deep-research")?.group, "claude");
  assert.equal(byName.get("deep-research")?.badge, "native");

  // Within the claude group, native (badged) options sort ahead of on-disk ones.
  const claude = options.filter((option) => option.group === "claude").map((option) => option.value);
  assert.ok(claude.indexOf("deep-research") < claude.indexOf("unity-mcp-orchestrator"), "native before on-disk");
});

test("a gaia-global skill overrides a same-named harness skill (imagegen bridge wins over ~/.codex)", async () => {
  const { workspace, gaiaHome, userHome } = await fixtureHomes();
  // Same skill name in the codex ecosystem AND gaia-global. skillRoots ranks
  // global ahead of codex, so the gaia bridge is what "imagegen" resolves to —
  // pure DATA precedence, no code deciding which skill loads.
  await writeSkill(join(userHome, ".codex", "skills"), "imagegen", "imagegen", "codex native");
  await writeSkill(join(gaiaHome, "skills"), "imagegen", "imagegen", "gaia bridge");
  const byName = new Map(discoverSkills(workspace, gaiaHome, userHome).map((s) => [s.name, s]));
  assert.equal(byName.get("imagegen")?.source, "global");
  assert.match(byName.get("imagegen")?.description ?? "", /gaia bridge/);
});

test("project .claude/skills resolves beside the workspace ROOT, not inside .gaia", async () => {
  const base = await mkdtemp(join(tmpdir(), "gaia-skills-claude-"));
  const root = join(base, "project");
  // Canonical workspace shape: rootDir = <root>, dir = <root>/.gaia. Claude
  // Code keeps project skills at <root>/.claude/skills — the old code joined
  // off workspace.dir and looked in <root>/.gaia/.claude/skills instead.
  const workspace = { rootDir: root, dir: join(root, ".gaia") };
  await writeSkill(join(root, ".claude", "skills"), "proj-skill", "proj-skill", "project claude skill");
  // A stray skill at the buggy location must NOT be picked up.
  await writeSkill(join(root, ".gaia", ".claude", "skills"), "ghost", "ghost");

  const gaiaHome = join(base, "gaia");
  const userHome = join(base, "home");
  const byName = new Map(discoverSkills(workspace, gaiaHome, userHome).map((s) => [s.name, s]));
  assert.equal(byName.get("proj-skill")?.source, "project");
  assert.ok(byName.get("proj-skill")?.path.startsWith(join(root, ".claude", "skills")));
  assert.equal(byName.get("ghost"), undefined);
});

test("agentSkillNames uses role defaults unless the agent explicitly overrides them", () => {
  const role = { skills: ["brave-search", "shared"] } as unknown as ResolvedRole;
  const agent = { skills: ["shared", "browser-tools"] } as unknown as AgentDef;
  assert.deepEqual(agentSkillNames(agent, role), ["brave-search", "shared"]);
  assert.deepEqual(agentSkillNames({ ...agent, skillOverride: ["browser-tools"] }, role), ["browser-tools"]);
  assert.deepEqual(agentSkillNames({ skills: undefined } as AgentDef, undefined), []);
});
