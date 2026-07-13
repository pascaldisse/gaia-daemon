import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/harness/index.js";
import { Daemon } from "../src/daemon.js";
import { readJson } from "../src/core/store.js";
import { globalPaths, workspacePaths } from "../src/core/paths.js";
import { ensureWorkspaceRoom, initWorkspace } from "../src/domain/workspace.js";
import { scaffoldGlobalAgent } from "../src/domain/agents.js";

test("deleteRoom does not resurrect the deleted current room as an empty directory", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project); // config.room = default
    await ensureWorkspaceRoom(project, "next-room");

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);

    const result = await daemon.deleteRoom(record.id, "default");

    assert.equal(result.snapshot.room.id, "next-room");
    assert.equal(existsSync(workspacePaths.roomDir(project, "default")), false, "deleted room must stay gone, not be recreated by loadWorkspace");
    assert.equal(existsSync(workspacePaths.roomDir(project, "next-room")), true);
    assert.equal((await readJson(workspacePaths.config(project)) as { room?: string }).room, "next-room");
    assert.ok(!result.snapshot.rooms.some((room) => room.id === "default"), "sidebar room list must not include the deleted room");

    const trashed = await readdir(workspacePaths.roomTrashDir(project));
    assert.ok(trashed.some((name) => name.startsWith("default__")), "deleted room is still recoverable from trash");
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});

test("deleteAgent trashes the agent directory and reloads agents list", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project);

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);

    // Create a test agent.
    const agentsDir = globalPaths.agentsDir();
    await scaffoldGlobalAgent(agentsDir, "test-agent", { displayName: "Test Agent" });

    // Verify the agent exists before deletion.
    const service = await daemon.serviceFor(record.id);
    assert.ok(service.workspace.agents["test-agent"], "test agent must exist before deletion");
    const agentDir = join(agentsDir, "test-agent");
    assert.ok(existsSync(agentDir), "agent directory must exist");

    // Delete the agent.
    const result = await daemon.deleteAgent("test-agent", record.id);

    // Verify the agent was removed from the agents list.
    assert.strictEqual(result.agents["test-agent"], undefined, "deleted agent must not be in agents list");
    assert.ok(existsSync(agentsDir), "agents directory itself must still exist");
    assert.equal(existsSync(agentDir), false, "deleted agent directory must be gone");

    // Verify the agent is in the trash.
    const trashed = await readdir(globalPaths.agentTrashDir());
    assert.ok(trashed.some((name) => name.startsWith("test-agent__")), "deleted agent must be recoverable from trash");
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});

test("deleteAgent throws when trying to delete a non-existent agent", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project);

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);

    // Try to delete a non-existent agent.
    await assert.rejects(
      () => daemon.deleteAgent("nonexistent", record.id),
      /Unknown agent/,
      "deleting a nonexistent agent must throw"
    );
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});

test("deleteAgent throws when trying to delete the default agent", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project);

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);

    // Get the default agent.
    const service = await daemon.serviceFor(record.id);
    const defaultAgentId = service.workspace.config.defaultAgent;

    // Try to delete the default agent.
    await assert.rejects(
      () => daemon.deleteAgent(defaultAgentId, record.id),
      /Cannot delete the default agent/,
      "deleting the default agent must throw"
    );
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});
