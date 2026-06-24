import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentRuntime } from "../src/runtime/runtime-factory.ts";
import { harnessSpecFor } from "../src/runtime/index.ts";
import { RunnerHost } from "../src/runtime/runner-host.ts";
import { PiRuntime } from "../src/runtime/pi-runtime.ts";
import { CodexRuntime } from "../src/runtime/codex-runtime.ts";
import { ClaudeRuntime } from "../src/runtime/claude-runtime.ts";
import { MemoryStore } from "../src/memory/memory-store.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import type { Workspace } from "../src/workspace/types.ts";
import type { AgentDefinition } from "../src/agents/types.ts";
import { createTempDir } from "./helpers/temp.ts";

async function withWorkspace(fn: (workspace: Workspace) => Promise<void>): Promise<void> {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  try {
    await initWorkspace(temp.path);
    await fn(await loadWorkspace(temp.path));
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
}

// Every harness now runs through the uniform per-(room, agent) runner, so the
// factory returns a RunnerHost regardless of harness. It still picks the harness
// (agent override > workspace config > default), which we verify via the
// capabilities the runner exposes from that harness's spec.

test("factory returns a RunnerHost carrying the default (pi) capabilities", async () => {
  await withWorkspace(async (workspace) => {
    const agent = workspace.agents.gaia;
    assert.ok(agent);
    assert.equal(agent.harness, "pi");
    assert.equal(workspace.config.harness, undefined);

    const runtime = createAgentRuntime({ workspace, agent });
    assert.ok(runtime instanceof RunnerHost);
    assert.equal(runtime.agent.id, "gaia");
    // pi: granular tools, no permission mode, all three gaia tools.
    assert.equal(runtime.capabilities.granularTools, true);
    assert.equal(runtime.capabilities.supportsPermissionMode, false);
    runtime.dispose();
  });
});

test("factory honors the agent harness override (claude capabilities)", async () => {
  await withWorkspace(async (workspace) => {
    const agent = { ...workspace.agents.gaia, harness: "claude" };
    const runtime = createAgentRuntime({ workspace, agent });
    assert.ok(runtime instanceof RunnerHost);
    assert.equal(runtime.capabilities.supportsPermissionMode, true);
    runtime.dispose();
  });
});

test("factory honors the workspace harness fallback (codex capabilities)", async () => {
  await withWorkspace(async (workspace) => {
    workspace.config.harness = "codex";
    const agent = { ...workspace.agents.gaia, harness: undefined };
    const runtime = createAgentRuntime({ workspace, agent });
    assert.ok(runtime instanceof RunnerHost);
    // codex: coarse sandbox (no granular tools), memory only.
    assert.equal(runtime.capabilities.granularTools, false);
    assert.equal(runtime.capabilities.gaiaTools.length, 1);
    runtime.dispose();
  });
});

// The runner builds the real runtime from the harness registry; verify each
// harness id maps to its runtime class (the construction the subprocess does).
test("the harness registry builds the right runtime class for each harness", async () => {
  await withWorkspace(async (workspace) => {
    const agent = workspace.agents.gaia as AgentDefinition;
    const ctx = { workspace, agent, memoryStore: new MemoryStore() };
    const pi = harnessSpecFor("pi").create(ctx);
    const codex = harnessSpecFor("codex").create(ctx);
    const claude = harnessSpecFor("claude").create(ctx);
    assert.ok(pi instanceof PiRuntime);
    assert.ok(codex instanceof CodexRuntime);
    assert.ok(claude instanceof ClaudeRuntime);
    pi.dispose();
    codex.dispose();
    claude.dispose();
  });
});
