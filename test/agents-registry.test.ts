import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureGlobalDefaultAgents, loadAgentDefinitions } from "../src/agents/registry.ts";
import { initWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

test("default agents use agent-owned persona folders", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    await ensureGlobalDefaultAgents(agentsDir);

    assert.equal(existsSync(join(agentsDir, "gaia", "agent.json")), true);
    assert.equal(existsSync(join(agentsDir, "gaia", "persona", "SOUL.md")), true);
    assert.equal(existsSync(join(agentsDir, "gaia", "persona", "MEMORY.md")), true);
    assert.equal(existsSync(join(agentsDir, "gaia", "persona", "roles")), true);

    const agents = await loadAgentDefinitions(agentsDir, join(temp.path, "project", ".gaia", "agents"));
    assert.equal(agents.gaia?.personaDir, join(agentsDir, "gaia", "persona"));
    assert.equal(agents.gaia?.soulPath, join(agentsDir, "gaia", "persona", "SOUL.md"));
    assert.equal(agents.gaia?.memoryPath, join(agentsDir, "gaia", "persona", "MEMORY.md"));
  } finally {
    await temp.cleanup();
  }
});

test("legacy root persona files migrate into persona/ with content preserved", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const legacyDir = join(agentsDir, "legacy");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "agent.json"), JSON.stringify({ id: "legacy", displayName: "Legacy" }), "utf8");
    await writeFile(join(legacyDir, "SOUL.md"), "# Custom Legacy Soul\n", "utf8");
    await writeFile(join(legacyDir, "MEMORY.md"), "# Custom Legacy Memory\n", "utf8");

    const agents = await loadAgentDefinitions(agentsDir, join(temp.path, "project", ".gaia", "agents"));

    assert.equal(agents.legacy?.soulPath, join(legacyDir, "persona", "SOUL.md"));
    assert.equal(agents.legacy?.memoryPath, join(legacyDir, "persona", "MEMORY.md"));
    assert.equal(await readFile(join(legacyDir, "persona", "SOUL.md"), "utf8"), "# Custom Legacy Soul\n");
    assert.equal(await readFile(join(legacyDir, "persona", "MEMORY.md"), "utf8"), "# Custom Legacy Memory\n");
    assert.equal(existsSync(join(legacyDir, "SOUL.md")), false);
    assert.equal(existsSync(join(legacyDir, "MEMORY.md")), false);
  } finally {
    await temp.cleanup();
  }
});

test("legacy project INTENT.md migrates into the project persona folder", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const projectAgentsDir = join(temp.path, "project", ".gaia", "agents");
    await ensureGlobalDefaultAgents(agentsDir);

    await mkdir(join(projectAgentsDir, "gaia"), { recursive: true });
    await writeFile(join(projectAgentsDir, "gaia", "INTENT.md"), "legacy intent", "utf8");
    const agents = await loadAgentDefinitions(agentsDir, projectAgentsDir);

    assert.equal(agents.gaia?.projectIntentPath, join(projectAgentsDir, "gaia", "persona", "INTENT.md"));
    assert.equal(await readFile(join(projectAgentsDir, "gaia", "persona", "INTENT.md"), "utf8"), "legacy intent");
    assert.equal(existsSync(join(projectAgentsDir, "gaia", "INTENT.md")), false);
  } finally {
    await temp.cleanup();
  }
});

test("gaia init seeds persona folders through GAIA_HOME", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  try {
    process.env.GAIA_HOME = join(temp.path, "home");
    await initWorkspace(join(temp.path, "project"));

    assert.equal(existsSync(join(temp.path, "home", "agents", "gaia", "persona", "SOUL.md")), true);
    assert.equal(existsSync(join(temp.path, "home", "agents", "gaia", "persona", "roles")), true);
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
