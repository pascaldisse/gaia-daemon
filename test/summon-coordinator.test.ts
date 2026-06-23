import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { AgentDefinition } from "../src/agents/types.ts";
import type { AgentRuntime } from "../src/runtime/types.ts";
import { GaiaController } from "../src/app/gaia-controller.ts";
import { SummonCoordinator } from "../src/app/summon-coordinator.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { readRoomState, roomStatePath } from "../src/room/state.ts";
import { createTempDir } from "./helpers/temp.ts";

// Yields a one-shot reply, so a summon's first turn completes immediately.
class ReplyRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";
  readonly capabilities = { gaiaTools: [], granularTools: true };
  constructor(readonly agent: AgentDefinition) {}
  resetRoom(): void {}
  async *send() {
    yield { type: "text-delta" as const, delta: `done by @${this.agent.id}` };
  }
  async abort(): Promise<void> {}
  dispose(): void {}
}

// Blocks its turn until release(), so a summon stays "running" for cap tests.
class BlockingRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";
  readonly capabilities = { gaiaTools: [], granularTools: true };
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  constructor(readonly agent: AgentDefinition) {}
  resetRoom(): void {}
  async *send() {
    await this.gate;
    yield { type: "text-delta" as const, delta: "ok" };
  }
  async abort(): Promise<void> {
    this.open();
  }
  dispose(): void {
    this.open();
  }
  release(): void {
    this.open();
  }
}

async function withWorkspace<T>(run: (ctx: { workspace: Awaited<ReturnType<typeof loadWorkspace>>; path: string }) => Promise<T>): Promise<T> {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    return await run({ workspace, path: temp.path });
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
}

test("a summon runs as a child room linked to its parent and returns the reply", async () => {
  await withWorkspace(async ({ workspace, path }) => {
    const agentId = workspace.config.defaultAgent;
    let coordinator!: SummonCoordinator;
    const controllerForRoom = async (roomId: string) =>
      new GaiaController({ workspaceId: "workspace", workspace, roomId, runtimeFactory: (agent) => new ReplyRuntime(agent), summonHost: coordinator });
    coordinator = new SummonCoordinator(workspace, path, controllerForRoom, 8);

    const reply = await coordinator.summonAndWait("default", agentId, "do a thing");
    assert.match(reply, /done by @/);

    // A completed summon is no longer "running" but persists as a child room.
    assert.equal(coordinator.runningChildren("default").length, 0);
    const rooms = (await readdir(workspace.roomsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const childRoom = rooms.find((room) => room !== "default");
    assert.ok(childRoom, "a child room was created");
    const state = await readRoomState(roomStatePath(workspace.roomsDir, childRoom!));
    assert.equal(state.parentRoomId, "default");
  });
});

test("enforces the per-room summon cap", async () => {
  await withWorkspace(async ({ workspace, path }) => {
    const agentId = workspace.config.defaultAgent;
    const runtimes: BlockingRuntime[] = [];
    let coordinator!: SummonCoordinator;
    const controllerForRoom = async (roomId: string) =>
      new GaiaController({
        workspaceId: "workspace",
        workspace,
        roomId,
        runtimeFactory: (agent) => {
          const runtime = new BlockingRuntime(agent);
          runtimes.push(runtime);
          return runtime;
        },
        summonHost: coordinator,
      });
    coordinator = new SummonCoordinator(workspace, path, controllerForRoom, 1);

    await coordinator.summon("default", agentId, "first"); // stays running (blocked)
    assert.equal(coordinator.runningChildren("default").length, 1);
    await assert.rejects(() => coordinator.summon("default", agentId, "second"), /Too many running summons/);

    // Let the blocked turn settle so its waitForIdle timer is cleared.
    runtimes.forEach((runtime) => runtime.release());
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
