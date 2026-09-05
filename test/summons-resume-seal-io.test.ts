import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummonCoordinator, type SummonRoomAccess } from "../src/services/summons.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, Workspace } from "../src/core/types.js";

// RC8 red — I/O TAIL race. RC7 sealed a watcher only AFTER settledOutcome
// RETURNED. But settledOutcome observes the room idle and then does more I/O
// (inspectWorker, latestReplyFrom) before returning: its view is already fixed
// while it is still "unsealed". A resume landing in that tail merges into a
// contract that can no longer observe its turn -> turn B stranded (predecessor
// closes the record "delivered", no watcher, boot sweep finds nothing).

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a resume landing in settledOutcome's I/O tail gets its own contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-resume-seal-io-"));
  const childRoomId = "terry-seal-io";
  const parentRoomId = "default";
  const statePath = workspacePaths.roomState(root, childRoomId);
  await mkdir(join(root, ".gaia", "rooms", childRoomId), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ parentRoomId, summon: { agentId: "terry", status: "delivered", deliver: "note" } })}\n`);

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

  const readState = async (): Promise<{ summon: { resumeStatus?: string } }> =>
    JSON.parse(await readFile(statePath, "utf8")) as { summon: { resumeStatus?: string } };

  const tailGate = deferred(); // holds watcher #1 INSIDE settledOutcome's tail I/O
  let inTail = false;
  let sends = 0;
  let replyReads = 0;
  const deliveries: string[] = [];

  const child: SummonRoomAccess = {
    async sendMessage() {
      sends += 1;
      return { id: `t${sends}`, status: "complete" };
    },
    subscribe() {
      return () => {};
    },
    async latestReplyFrom() {
      replyReads += 1;
      if (replyReads === 1) {
        inTail = true;
        await tailGate.promise; // idle already observed; view fixed; still pre-return
      }
      return `reply-${replyReads}`;
    },
    async waitForSettled() {},
    async hasPendingWork() {
      return false;
    },
    async getSnapshot() {
      return { tasks: [{ id: `t${sends}`, status: "complete" }] };
    },
    async deliverAgentResult() {},
    async markSummonDelivered() {},
    async markSummonResumeDelivered(token?: string) {
      const state = JSON.parse(await readFile(statePath, "utf8")) as { summon: { resumeStatus?: string; resumeStartedAt?: string } };
      if (token !== undefined && state.summon.resumeStartedAt !== token) return;
      state.summon.resumeStatus = "delivered";
      await writeFile(statePath, `${JSON.stringify(state)}\n`);
    },
    async broadcastRoomsChanged() {},
    async runCancelCommand() {
      return "cancelled";
    },
  };

  const parent: SummonRoomAccess = {
    ...child,
    async deliverAgentResult(_from, reply) {
      deliveries.push(reply);
    },
  };

  const coordinator = new SummonCoordinator(workspace, root, async (roomId: string) => (roomId === parentRoomId ? parent : child), async () => 8, () => {});

  assert.equal((await coordinator.resume(childRoomId, child, "m1")).tracked, true);
  for (let i = 0; i < 200 && !inTail; i += 1) await sleep(5);
  assert.equal(inTail, true, "watcher #1 is inside settledOutcome's tail I/O");

  // Turn B lands while watcher #1's view of the room is already fixed.
  assert.equal((await coordinator.resume(childRoomId, child, "m2")).tracked, true);
  tailGate.resolve();

  for (let i = 0; i < 400 && deliveries.length < 2; i += 1) await sleep(5);
  assert.equal(deliveries.length, 2, "turn B was watched and delivered too (not stranded)");
  assert.equal((await readState()).summon.resumeStatus, "delivered");
});
