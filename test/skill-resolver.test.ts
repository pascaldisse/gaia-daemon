import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { globalSkillsPath, projectSkillsPath, resolveSkillRefs } from "../src/skills/skill-resolver.ts";
import { createTempDir } from "./helpers/temp.ts";

async function writeSkill(root: string, name: string): Promise<string> {
  const path = join(root, name, "SKILL.md");
  await mkdir(join(root, name), { recursive: true });
  await writeFile(path, `# ${name}\n`, "utf8");
  return path;
}

test("returns conventional global and project skill roots", async () => {
  const temp = await createTempDir();
  try {
    const workspace = { dir: join(temp.path, "project", ".gaia") };

    assert.equal(globalSkillsPath(join(temp.path, "home")), join(temp.path, "home", "skills"));
    assert.equal(projectSkillsPath(workspace), join(temp.path, "project", ".gaia", "skills"));
  } finally {
    await temp.cleanup();
  }
});

test("resolves global-only and project-only skills", async () => {
  const temp = await createTempDir();
  try {
    const workspace = { dir: join(temp.path, "project", ".gaia") };
    const home = join(temp.path, "home");
    const globalPath = await writeSkill(globalSkillsPath(home), "brainstorm");
    const projectPath = await writeSkill(projectSkillsPath(workspace), "research");

    const result = resolveSkillRefs(workspace, ["brainstorm", "research"], home);

    assert.deepEqual(result.skills, [
      { name: "brainstorm", path: globalPath, source: "global" },
      { name: "research", path: projectPath, source: "project" },
    ]);
    assert.deepEqual(result.paths, [globalPath, projectPath]);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await temp.cleanup();
  }
});

test("project skills win over global skills on name collision", async () => {
  const temp = await createTempDir();
  try {
    const workspace = { dir: join(temp.path, "project", ".gaia") };
    const home = join(temp.path, "home");
    await writeSkill(globalSkillsPath(home), "plan");
    const projectPath = await writeSkill(projectSkillsPath(workspace), "plan");

    const result = resolveSkillRefs(workspace, ["plan"], home);

    assert.deepEqual(result.skills, [{ name: "plan", path: projectPath, source: "project" }]);
  } finally {
    await temp.cleanup();
  }
});

test("unknown and unsafe skills produce diagnostics and are omitted", async () => {
  const temp = await createTempDir();
  try {
    const workspace = { dir: join(temp.path, "project", ".gaia") };
    const home = join(temp.path, "home");
    const knownPath = await writeSkill(globalSkillsPath(home), "known");

    const result = resolveSkillRefs(workspace, ["known", "missing", "../secret"], home);

    assert.deepEqual(result.paths, [knownPath]);
    assert.match(result.diagnostics.join("\n"), /Unknown skill: missing/);
    assert.match(result.diagnostics.join("\n"), /Ignoring unsafe skill name/);
  } finally {
    await temp.cleanup();
  }
});

test("skill order is deterministic and deduplicated", async () => {
  const temp = await createTempDir();
  try {
    const workspace = { dir: join(temp.path, "project", ".gaia") };
    const home = join(temp.path, "home");
    const b = await writeSkill(globalSkillsPath(home), "b");
    const a = await writeSkill(globalSkillsPath(home), "a");

    const result = resolveSkillRefs(workspace, ["b", "a", "b"], home);

    assert.deepEqual(result.paths, [b, a]);
  } finally {
    await temp.cleanup();
  }
});
