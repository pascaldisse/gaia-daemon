import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { listAgentRoles, parseRoleMarkdown, resolveAgentRole } from "../src/roles/roles.ts";
import { createTempDir } from "./helpers/temp.ts";

function agent(globalRolesDir: string, projectRolesDir?: string): AgentDefinition {
  return {
    id: "gaia",
    displayName: "Gaia",
    icon: "☀️",
    dir: join(globalRolesDir, "..", ".."),
    configPath: "agent.json",
    personaDir: join(globalRolesDir, ".."),
    rolesDir: globalRolesDir,
    soulPath: "SOUL.md",
    memoryPath: "MEMORY.md",
    tools: [],
    projectRolesDir,
  };
}

test("parses role frontmatter skills and markdown body", () => {
  const parsed = parseRoleMarkdown(`---\nskills:\n  - brainstorm\n  - web\n  - web\n---\n# Brainstorm\n\nExplore softly.\n`, "brainstorm.md");

  assert.deepEqual(parsed.skills, ["brainstorm", "web"]);
  assert.equal(parsed.body, "# Brainstorm\n\nExplore softly.");
  assert.deepEqual(parsed.diagnostics, []);
});

test("parses inline skill arrays", () => {
  const parsed = parseRoleMarkdown(`---\nskills: [brainstorm, 'web']\n---\nBody\n`);

  assert.deepEqual(parsed.skills, ["brainstorm", "web"]);
  assert.equal(parsed.body, "Body");
});

test("content without a closing frontmatter marker stays plain body", () => {
  const content = `---\nskills:\n  - plan\n# Missing close\n`;
  const parsed = parseRoleMarkdown(content, "broken.md");

  assert.equal(parsed.body, content);
  assert.deepEqual(parsed.skills, []);
  assert.deepEqual(parsed.diagnostics, []);
});

test("a non-list skills declaration reports a diagnostic", () => {
  const parsed = parseRoleMarkdown(`---\nskills: web\n---\nBody\n`, "broken.md");

  assert.equal(parsed.body, "Body");
  assert.deepEqual(parsed.skills, []);
  assert.match(parsed.diagnostics[0] ?? "", /expected a list/);
});

test("resolves global role plus project overlay in prompt order", async () => {
  const temp = await createTempDir();
  try {
    const globalRolesDir = join(temp.path, "home", "agents", "gaia", "persona", "roles");
    const projectRolesDir = join(temp.path, "project", ".gaia", "agents", "gaia", "persona", "roles");
    await mkdir(globalRolesDir, { recursive: true });
    await mkdir(projectRolesDir, { recursive: true });
    await writeFile(join(globalRolesDir, "brainstorm.md"), `---\nskills:\n  - brainstorm\n  - web\n---\nGlobal role body\n`, "utf8");
    await writeFile(join(projectRolesDir, "brainstorm.md"), `---\nskills:\n  - web\n  - plan\n---\nProject overlay body\n`, "utf8");

    const resolved = await resolveAgentRole(agent(globalRolesDir, projectRolesDir), "brainstorm");

    assert.equal(resolved?.name, "brainstorm");
    assert.equal(resolved?.prompt, "Global role body\n\nProject overlay body");
    assert.deepEqual(resolved?.skills, ["brainstorm", "web", "plan"]);
  } finally {
    await temp.cleanup();
  }
});

test("lists available global and project roles", async () => {
  const temp = await createTempDir();
  try {
    const globalRolesDir = join(temp.path, "global");
    const projectRolesDir = join(temp.path, "project");
    await mkdir(globalRolesDir, { recursive: true });
    await mkdir(projectRolesDir, { recursive: true });
    await writeFile(join(globalRolesDir, "brainstorm.md"), "Global", "utf8");
    await writeFile(join(projectRolesDir, "research.md"), "Project", "utf8");
    await writeFile(join(projectRolesDir, "not-a-role.txt"), "Nope", "utf8");

    assert.deepEqual(await listAgentRoles(agent(globalRolesDir, projectRolesDir)), ["brainstorm", "research"]);
  } finally {
    await temp.cleanup();
  }
});

test("missing or unsafe roles resolve to undefined", async () => {
  const temp = await createTempDir();
  try {
    const globalRolesDir = join(temp.path, "roles");
    await mkdir(globalRolesDir, { recursive: true });

    assert.equal(await resolveAgentRole(agent(globalRolesDir), "missing"), undefined);
    assert.equal(await resolveAgentRole(agent(globalRolesDir), "../secret"), undefined);
  } finally {
    await temp.cleanup();
  }
});
