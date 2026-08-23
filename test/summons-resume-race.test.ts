import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummonCoordinator, type SummonRoomAccess } from "../src/services/summons.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, Workspace } from "../src/core/types.js";

// Artificial race for the resume no-delivery window: a SECOND `gaia resume`
// lands while the FIRST resume's watcher is still in flight, and the first
// watcher settles INSIDE the second's `sendMessage` await. Pre-fix the first
// watcher's unconditional markSummonResumeDelivered() cleared the SECOND
// resume's freshly-written "running" stamp — a crash right then would make the
// boot sweep skip a resume that really is still running (no delivery, ever).

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

test("a joined resume re-arms after its predecessor settles during send", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-resume-race-"));
  const childRoomId = "terry-race";
  const parentRoomId = "default";
  const statePath = workspacePaths.roomState(root, childRoomId);
  await mkdir(join(root, ".gaia", "rooms", childRoomId), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      parentRoomId,
      summon: { agentId: "terry", status: "delivered", deliver: "note" },
    })}\n`,
  );

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

  const readState = async (): Promise<{ summon: { resumeStatus?: string; resumeStartedAt?: string } }> =>
    JSON.parse(await readFile(statePath, "utf8")) as { summon: { resumeStatus?: string; resumeStartedAt?: string } };

  const settleGate = deferred(); // holds resume #1's watcher
  const sendGate = deferred(); // holds resume #2's sendMessage
  let sends = 0;
  const deliveries: string[] = [];

  const child: SummonRoomAccess = {
    async sendMessage(text) {
      sends += 1;
      if (sends === 2) await sendGate.promise;
      return { id: `t${sends}`, status: "complete" };
    },
    subscribe() {
      return () => {};
    },
    async latestReplyFrom() {
      return "done";
    },
    async waitForSettled() {
      if (sends === 1) await settleGate.promise;
    },
    async hasPendingWork() {
      return false;
    },
    async getSnapshot() {
      return { tasks: [{ id: `t${sends}`, status: "complete" }] };
    },
    async deliverAgentResult() {},
    async markSummonDelivered() {},
    // Mirrors RoomService#markSummonResumeDelivered: stamp-keyed write to disk.
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

  const coordinator = new SummonCoordinator(
    workspace,
    root,
    async (roomId: string) => (roomId === parentRoomId ? parent : child),
    async () => 8,
    () => {},
  );

  const first = await coordinator.resume(childRoomId, child, "m1");
  assert.equal(first.tracked, true);
  const stamp1 = (await readState()).summon.resumeStartedAt;

  await sleep(5); // distinct ISO stamp for resume #2
  const second = coordinator.resume(childRoomId, child, "m2");

  // ...and NOW let resume #1's watcher settle + deliver, mid-await.
  settleGate.resolve();
  for (let i = 0; i < 200 && deliveries.length === 0; i += 1) await sleep(5);
  assert.equal(deliveries.length, 1, "resume #1 delivered to the parent");

  assert.equal((await readState()).summon.resumeStatus, "delivered");

  sendGate.resolve();
  assert.equal((await second).tracked, true);
  for (let i = 0; i < 200 && deliveries.length < 2; i += 1) await sleep(5);
  assert.equal(deliveries.length, 2, "resume #2's own turn was watched and delivered");
  const after = await readState();
  assert.equal(after.summon.resumeStatus, "delivered");
});
