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
    assert.equal(existsSync(join(agentsDir, "gaia", "persona", "memory", "MEMORY.md")), true);
    assert.equal(existsSync(join(agentsDir, "gaia", "persona", "memory", "USER.md")), true);
    assert.equal(existsSync(join(agentsDir, "gaia", "persona", "roles")), true);

    const agents = await loadAgentDefinitions(agentsDir, join(temp.path, "project", ".gaia", "agents"));
    assert.equal(agents.gaia?.personaDir, join(agentsDir, "gaia", "persona"));
    assert.equal(agents.gaia?.soulPath, join(agentsDir, "gaia", "persona", "SOUL.md"));
    assert.equal(agents.gaia?.memoryDir, join(agentsDir, "gaia", "persona", "memory"));
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
    assert.equal(agents.legacy?.memoryDir, join(legacyDir, "persona", "memory"));
    assert.equal(await readFile(join(legacyDir, "persona", "SOUL.md"), "utf8"), "# Custom Legacy Soul\n");
    assert.equal(await readFile(join(legacyDir, "persona", "memory", "MEMORY.md"), "utf8"), "# Custom Legacy Memory\n");
    assert.equal(existsSync(join(legacyDir, "SOUL.md")), false);
    assert.equal(existsSync(join(legacyDir, "MEMORY.md")), false);
    assert.equal(existsSync(join(legacyDir, "persona", "MEMORY.md")), false);
  } finally {
    await temp.cleanup();
  }
});

test("single persona MEMORY.md migrates into the memory directory", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const personaDir = join(agentsDir, "muse", "persona");
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(agentsDir, "muse", "agent.json"), JSON.stringify({ id: "muse", displayName: "Muse" }), "utf8");
    await writeFile(join(personaDir, "SOUL.md"), "# Muse\n", "utf8");
    await writeFile(join(personaDir, "MEMORY.md"), "# Muse Memory\n\nremember this\n", "utf8");

    const agents = await loadAgentDefinitions(agentsDir, join(temp.path, "project", ".gaia", "agents"));

    assert.equal(agents.muse?.memoryDir, join(personaDir, "memory"));
    assert.equal(await readFile(join(personaDir, "memory", "MEMORY.md"), "utf8"), "# Muse Memory\n\nremember this\n");
    assert.equal(existsSync(join(personaDir, "MEMORY.md")), false);
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

test("parses harness from agent.json", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const agentDir = join(agentsDir, "rex");
    const personaDir = join(agentDir, "persona");
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(agentDir, "agent.json"), JSON.stringify({ id: "rex", displayName: "Rex", harness: "codex" }), "utf8");
    await writeFile(join(personaDir, "SOUL.md"), "# Rex\n", "utf8");

    const agents = await loadAgentDefinitions(agentsDir, join(temp.path, "project", ".gaia", "agents"));
    assert.equal(agents.rex?.harness, "codex");
  } finally {
    await temp.cleanup();
  }
});

test("parses harness override from project agent.json", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const projectAgentsDir = join(temp.path, "project", ".gaia", "agents");
    const agentDir = join(agentsDir, "rex");
    const personaDir = join(agentDir, "persona");
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(agentDir, "agent.json"), JSON.stringify({ id: "rex", displayName: "Rex", harness: "pi" }), "utf8");
    await writeFile(join(personaDir, "SOUL.md"), "# Rex\n", "utf8");

    // Project override sets harness to codex
    const projectAgentDir = join(projectAgentsDir, "rex");
    await mkdir(projectAgentDir, { recursive: true });
    await writeFile(join(projectAgentDir, "agent.json"), JSON.stringify({ harness: "codex" }), "utf8");

    const agents = await loadAgentDefinitions(agentsDir, projectAgentsDir);
    assert.equal(agents.rex?.harness, "codex");
  } finally {
    await temp.cleanup();
  }
});

test("ignores invalid harness values", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const agentDir = join(agentsDir, "rex");
    const personaDir = join(agentDir, "persona");
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(agentDir, "agent.json"), JSON.stringify({ id: "rex", displayName: "Rex", harness: "unknown" }), "utf8");
    await writeFile(join(personaDir, "SOUL.md"), "# Rex\n", "utf8");

    const agents = await loadAgentDefinitions(agentsDir, join(temp.path, "project", ".gaia", "agents"));
    assert.equal(agents.rex?.harness, undefined);
  } finally {
    await temp.cleanup();
  }
});
