import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummonCoordinator, type SummonRoomAccess } from "../src/services/summons.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, Workspace } from "../src/core/types.js";

function agent(id: string): AgentDef {
  return {
    id,
    displayName: id,
    icon: "*",
    dir: "/agent",
    configPath: "/agent/agent.json",
    personaDir: "/agent/persona",
    rolesDir: "/agent/persona/roles",
    soulPath: "/agent/persona/SOUL.md",
    memoryDir: "/agent/persona/memory",
    tools: [],
  };
}

function settledRoom(): SummonRoomAccess {
  return {
    async sendMessage() {
      return { id: "settled", status: "complete" };
    },
    subscribe() {
      return () => {};
    },
    async latestReplyFrom() {
      return "done";
    },
    async waitForSettled() {},
    async hasPendingWork() {
      return false;
    },
    async getSnapshot() {
      return { tasks: [{ id: "settled", status: "complete" }] };
    },
    async deliverAgentResult() {},
    async markSummonDelivered() {},
    async markSummonResumeDelivered() {},
    async broadcastRoomsChanged() {},
    async runCancelCommand() {
      return "cancelled";
    },
  };
}

test("summon child stamping preserves an already-existing room state", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-summon-runtime-state-"));
  const workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "global-agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent("gaia"), terry: agent("terry") },
  } satisfies Workspace;
  const childRoomId = "terry-0";
  const statePath = workspacePaths.roomState(root, childRoomId);
  await mkdir(join(root, ".gaia", "rooms", childRoomId), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      activeRoles: {},
      agentCursors: { gaia: "cursor-survives" },
      queue: [{ id: "queued-work" }],
      futurePluginState: { retained: true },
    })}\n`,
  );

  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 0;
  Math.random = () => 0;
  try {
    const coordinator = new SummonCoordinator(workspace, root, async () => settledRoom(), async () => 8, () => {});
    const { done } = await coordinator.launch("default", "terry", "test");
    await done;
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }

  const after = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(after.agentCursors, { gaia: "cursor-survives" });
  assert.deepEqual(after.queue, [{ id: "queued-work" }]);
  assert.deepEqual(after.futurePluginState, { retained: true });
  assert.equal(after.parentRoomId, "default");
});
