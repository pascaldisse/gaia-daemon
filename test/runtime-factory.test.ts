import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentRuntime } from "../src/runtime/runtime-factory.ts";
import { PiRuntime } from "../src/runtime/pi-runtime.ts";
import { CodexRuntime } from "../src/runtime/codex-runtime.ts";
import { MemoryStore } from "../src/memory/memory-store.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

test("factory defaults to PiRuntime when no harness is configured", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const agent = workspace.agents.gaia;
    assert.ok(agent);
    assert.equal(agent?.harness, undefined);
    assert.equal(workspace.config.harness, undefined);

    const runtime = createAgentRuntime({
      workspace,
      agent: agent!,
      memoryStore: new MemoryStore(),
    });
    assert.ok(runtime instanceof PiRuntime);
    assert.equal(runtime.agent.id, "gaia");
    runtime.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("factory uses agent harness override", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const agent = { ...workspace.agents.gaia, harness: "pi" as const };
    assert.ok(agent);

    const runtime = createAgentRuntime({
      workspace,
      agent,
      memoryStore: new MemoryStore(),
    });
    assert.ok(runtime instanceof PiRuntime);
    runtime.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("factory uses CodexRuntime when agent harness is codex", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const agent = { ...workspace.agents.gaia, harness: "codex" as const };

    const runtime = createAgentRuntime({
      workspace,
      agent,
      memoryStore: new MemoryStore(),
    });
    assert.ok(runtime instanceof CodexRuntime);
    assert.equal(runtime.agent.id, "gaia");
    runtime.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("factory uses CodexRuntime when workspace config harness is codex", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    workspace.config.harness = "codex";
    const agent = workspace.agents.gaia;

    const runtime = createAgentRuntime({
      workspace,
      agent: agent!,
      memoryStore: new MemoryStore(),
    });
    assert.ok(runtime instanceof CodexRuntime);
    runtime.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});
