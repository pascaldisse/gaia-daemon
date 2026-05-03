import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { GaiaController, type GaiaUiEvent } from "../src/app/gaia-controller.ts";
import type { AgentRuntime } from "../src/runtime/types.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

class FakeRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";

  constructor(readonly agent: AgentDefinition) {}

  async *send() {
    yield { type: "text-delta" as const, delta: `hello from ${this.agent.id}` };
  }

  dispose(): void {}
}

test("streams a room task through UI-neutral events", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");

  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);
    const controller = new GaiaController({
      cwd: temp.path,
      workspaceId: "workspace",
      workspace,
      runtimeFactory: (agent) => new FakeRuntime(agent),
    });
    const events: GaiaUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const task = await controller.sendMessage("hello");
    await waitFor(() => events.some((event) => event.type === "task-end" && event.task.id === task.id));
    const snapshot = await controller.getSnapshot();

    assert.equal(task.status, "complete");
    assert.ok(events.some((event) => event.type === "task-start"));
    assert.ok(events.some((event) => event.type === "text-delta"));
    assert.equal(snapshot.room.events.at(-1)?.author, "gaia");
    assert.match(snapshot.room.events.at(-1)?.text ?? "", /hello from gaia/);
    controller.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for predicate");
}
