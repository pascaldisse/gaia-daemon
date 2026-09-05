import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummonCoordinator, type SummonRoomAccess } from "../src/services/summons.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, Workspace } from "../src/core/types.js";

// SEAL OWNERSHIP red — the seal registry used to be a Set<string> keyed by
// room only. A successor watcher (S) armed while predecessor (P) was sealed
// seals the SAME room key; P's `finally` then deletes that key blind, so the
// room reads "unsealed" while S is provably sealed (inside its parent write).
// A third resume landing there merges into S — which can no longer observe it
// — and turn C is stranded. Fix: Map<roomId, ResumeEpoch>, delete only when
// the stored token is still your own.

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

test("a predecessor's cleanup never unseals its successor's watcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-resume-seal-own-"));
  const childRoomId = "terry-seal-own";
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

  const gateP = deferred(); // holds P inside deliverResume (already sealed)
  const gateS = deferred(); // holds S inside deliverResume (already sealed)
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
      if (deliveries.length === 1) await gateP.promise;
      else if (deliveries.length === 2) await gateS.promise;
    },
  };

  const coordinator = new SummonCoordinator(workspace, root, async (roomId: string) => (roomId === parentRoomId ? parent : child), async () => 8, () => {});

  // Turn A: watcher P seals, then parks inside the parent write.
  assert.equal((await coordinator.resume(childRoomId, child, "m1")).tracked, true);
  for (let i = 0; i < 200 && deliveries.length < 1; i += 1) await sleep(5);
  assert.equal(deliveries.length, 1, "P is sealed and inside its parent write");

  // Turn B: sees a sealed room -> arms successor S, which seals in turn and
  // parks inside its own parent write.
  assert.equal((await coordinator.resume(childRoomId, child, "m2")).tracked, true);
  for (let i = 0; i < 200 && deliveries.length < 2; i += 1) await sleep(5);
  assert.equal(deliveries.length, 2, "S is sealed and inside its parent write");

  // P finishes and cleans up. Room-keyed seal state => S is silently unsealed.
  gateP.resolve();
  await sleep(50);

  // Turn C lands while S is provably sealed: it must get its own contract.
  assert.equal((await coordinator.resume(childRoomId, child, "m3")).tracked, true);
  gateS.resolve();

  for (let i = 0; i < 400 && deliveries.length < 3; i += 1) await sleep(5);
  assert.equal(deliveries.length, 3, "turn C was watched and delivered too (not stranded)");
});
