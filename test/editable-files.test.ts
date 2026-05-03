import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EditableFileRegistry } from "../src/app/editable-files.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

test("lists and writes only descriptor-backed workspace files", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    await mkdir(join(temp.path, ".gaia", "skills", "planner"), { recursive: true });
    await writeFile(join(temp.path, ".gaia", "skills", "planner", "SKILL.md"), "# Planner\n\n- plan\n", "utf8");

    const workspace = await loadWorkspace(temp.path);
    const registry = new EditableFileRegistry(async () => workspace);
    const files = await registry.listWorkspace("workspace");
    const agents = files.find((file) => file.label === "AGENTS.md");
    const skill = files.find((file) => file.label === join(".gaia", "skills", "planner", "SKILL.md"));

    assert.ok(agents);
    assert.ok(skill);
    await registry.write(agents.id, "# Project Instructions\n\nKeep it small.\n", "workspace");

    assert.equal(await readFile(join(temp.path, "AGENTS.md"), "utf8"), "# Project Instructions\n\nKeep it small.\n");
    await assert.rejects(() => registry.read("workspace_not_real", "workspace"), /Editable file not found/);
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});
