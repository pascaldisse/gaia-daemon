import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/harness/index.js";
import { Daemon } from "../src/daemon.js";
import { readJson, writeJsonAtomic } from "../src/core/store.js";
import { globalPaths, workspacePaths } from "../src/core/paths.js";
import type { UiEvent } from "../src/core/types.js";
import { RoomHandle } from "../src/domain/rooms.js";
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

    const deleted = await RoomHandle.open(project, "default");
    await deleted.updateState((state) => { state.petBindings = { gaia: "gaia" }; });
    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);
    const broadcasts: UiEvent[] = [];
    daemon.subscribe((event) => broadcasts.push(event));

    const result = await daemon.deleteRoom(record.id, "default");

    assert.equal(result.snapshot.room.id, "next-room");
    assert.equal(existsSync(workspacePaths.roomDir(project, "default")), false, "deleted room must stay gone, not be recreated by loadWorkspace");
    assert.equal(existsSync(workspacePaths.roomDir(project, "next-room")), true);
    assert.equal((await readJson(workspacePaths.config(project)) as { room?: string }).room, "next-room");
    assert.ok(!result.snapshot.rooms.some((room) => room.id === "default"), "sidebar room list must not include the deleted room");
    const petSnapshot = broadcasts.find((event) => event.type === "pet-bindings");
    assert.ok(petSnapshot?.type === "pet-bindings" && petSnapshot.bindings.length === 0, "deleting the room closes its native pet window");

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

    // Delete the agent, then reload the affected services (what the HTTP handler does).
    await daemon.deleteAgent("test-agent");
    await daemon.applySettingsChange("global");

    // Verify the agent is gone after a reload.
    const reloaded = await daemon.serviceFor(record.id);
    assert.strictEqual(reloaded.workspace.agents["test-agent"], undefined, "deleted agent must not be in agents list");
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
      () => daemon.deleteAgent("nonexistent"),
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

    // Try to delete the default agent — refused (would break the workspace).
    await assert.rejects(
      () => daemon.deleteAgent(defaultAgentId),
      /Cannot delete @/,
      "deleting the default agent must throw"
    );
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});

test("applySettingsChange refreshes cached summon coordinators in place (new agent summonable w/o restart, live lanes survive)", async () => {
  const previousHome = process.env.GAIA_HOME;
  const home = await mkdtemp(join(tmpdir(), "gaia-home-"));
  process.env.GAIA_HOME = home;
  try {
    const project = await mkdtemp(join(tmpdir(), "gaia-project-"));
    await initWorkspace(project);
    // cap=1 so a post-reload launch of a KNOWN agent stops at the cap check (no harness spawn)
    const config = await readJson(workspacePaths.config(project)) as Record<string, unknown>;
    await writeJsonAtomic(workspacePaths.config(project), { ...config, maxSummonsPerRoom: 1 });

    const daemon = new Daemon({ cwd: project, log: () => {} });
    const record = await daemon.registry.add(project);
    const coordinator = await daemon.coordinatorFor(record.id); // caches boot-time workspace
    assert.equal(daemon.summonCoordinators.get(record.id), coordinator);

    // pre-existing active summon entry (same shape launch() records)
    const running = (coordinator as unknown as { running: Map<string, unknown> }).running;
    running.set("live-child", { roomId: "live-child", parentRoomId: "default", agentId: "gaia", prompt: "x", untrusted: false });

    await assert.rejects(() => coordinator.launch("default", "fresh-agent", "t"), /Unknown agent/, "before reload: new agent unknown");

    await scaffoldGlobalAgent(globalPaths.agentsDir(), "fresh-agent", { displayName: "Fresh" });
    await daemon.applySettingsChange("global");

    assert.equal(daemon.summonCoordinators.get(record.id), coordinator, "same coordinator instance (not cleared)");
    assert.ok(running.has("live-child"), "active summon entry survives reload");
    await assert.rejects(
      () => coordinator.launch("default", "fresh-agent", "t"),
      (error: Error) => !/Unknown agent/.test(error.message) && /Too many running summons/.test(error.message),
      "after reload: agent known (stops at cap, not Unknown agent)",
    );
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});
