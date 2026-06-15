import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AgentDefinition } from "../src/agents/types.ts";
import { SummonManager, type SummonRuntimeEvent } from "../src/app/summon-manager.ts";
import type { AgentRuntime } from "../src/runtime/types.ts";
import { MemoryStore } from "../src/memory/memory-store.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import {
  readSummonEvents,
  readSummonResult,
  readSummonSession,
  summonDir,
} from "../src/room/summons.ts";
import { createTempDir } from "./helpers/temp.ts";

class FakeRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";

  constructor(readonly agent: AgentDefinition) {}

  async *send() {
    yield { type: "model-info" as const, provider: "fake", modelId: "m1", subscription: false };
    yield { type: "text-delta" as const, delta: `[@${this.agent.id}] Task result: done.` };
  }

  async abort(): Promise<void> {}

  dispose(): void {}
}

test("creates a summon session and streams events to persistence", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const emitted: SummonRuntimeEvent[] = [];
    const manager = new SummonManager(
      "workspace",
      workspace,
      (agent) => new FakeRuntime(agent),
      (event) => {
        if (
          event.type === "summon-start" ||
          event.type === "summon-event" ||
          event.type === "summon-end"
        ) {
          emitted.push(event as unknown as SummonRuntimeEvent);
        }
      },
      new MemoryStore(),
    );

    const session = await manager.create(workspace.config.room, "gaia", "test task");
    assert.equal(session.agentId, "gaia");
    assert.equal(session.prompt, "test task");
    assert.equal(session.status, "running");
    assert.equal(session.harness, "pi");

    // Wait for the async summon to finish.
    const completed = await manager.waitForEnd(session.id, 3000);
    assert.equal(completed?.status, "complete");
    await waitFor(() => emitted.some((e) => e.type === "summon-end"));
    const endEvent = emitted.find((e) => e.type === "summon-end");
    assert.ok(endEvent);
    assert.equal(endEvent!.session.status, "complete");

    // Verify persistence on disk.
    const dir = summonDir(workspace.roomsDir, workspace.config.room, session.id);
    assert.ok(existsSync(dir));
    const persisted = await readSummonSession(dir);
    assert.equal(persisted?.status, "complete");
    assert.ok(persisted?.summary?.includes("Task result: done."));

    const events = await readSummonEvents(dir);
    assert.ok(events.some((e) => e.type === "model-info"));
    assert.ok(events.some((e) => e.type === "text-delta"));

    const result = await readSummonResult(dir);
    assert.ok(result.includes("Task result: done."));
    manager.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("limits concurrent running summons per room", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);

    class SlowRuntime implements AgentRuntime {
      readonly modelLabel = "fake/model";
      private aborted = false;

      constructor(readonly agent: AgentDefinition) {}

      async *send() {
        while (!this.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "text-delta" as const, delta: "cancelled mid-run" };
      }

      async abort(): Promise<void> {
        this.aborted = true;
      }

      dispose(): void {}
    }

    const manager = new SummonManager(
      "workspace",
      workspace,
      (agent) => new SlowRuntime(agent),
      () => {},
      new MemoryStore(),
      { maxRunningPerRoom: 1 },
    );

    const first = await manager.create(workspace.config.room, "gaia", "slow task");
    await assert.rejects(
      () => manager.create(workspace.config.room, "gaia", "another slow task"),
      /Too many running summons/,
    );

    await manager.cancel(first.id);
    const second = await manager.create(workspace.config.room, "gaia", "after cancel");
    assert.equal(second.status, "running");
    await manager.cancel(second.id);
    manager.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("cancels a running summon", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const emitted: SummonRuntimeEvent[] = [];

    class SlowRuntime implements AgentRuntime {
      readonly modelLabel = "fake/model";
      private aborted = false;

      constructor(readonly agent: AgentDefinition) {}

      async *send() {
        while (!this.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
        yield { type: "text-delta" as const, delta: "cancelled mid-run" };
      }

      async abort(): Promise<void> {
        this.aborted = true;
      }

      dispose(): void {}
    }

    const manager = new SummonManager(
      "workspace",
      workspace,
      (agent) => new SlowRuntime(agent),
      (event) => {
        if (
          event.type === "summon-start" ||
          event.type === "summon-event" ||
          event.type === "summon-end"
        ) {
          emitted.push(event as unknown as SummonRuntimeEvent);
        }
      },
      new MemoryStore(),
    );

    const session = await manager.create(workspace.config.room, "gaia", "slow task");
    await waitFor(() => emitted.some((e) => e.type === "summon-start"));

    const cancelled = await manager.cancel(session.id);
    assert.equal(cancelled?.status, "cancelled");

    await waitFor(() => emitted.some((e) => e.type === "summon-end"));
    manager.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("rejects unknown agent in summon create", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const manager = new SummonManager(
      "workspace",
      workspace,
      (agent) => new FakeRuntime(agent),
      () => {},
      new MemoryStore(),
    );

    await assert.rejects(
      () => manager.create(workspace.config.room, "nope", "test"),
      /Unknown agent: @nope/,
    );
    manager.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for predicate");
}
