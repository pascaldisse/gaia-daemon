import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummonCoordinator, type SummonRoomAccess } from "../src/services/summons.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef, Workspace } from "../src/core/types.js";

// RC7 red: the merge guard judged "a watcher is live" by an UNSETTLED
// completion promise. A watcher that already sampled its outcome
// (waitForDelegatedWork + settledOutcome done, blocked inside the parent
// write) is live by that test but covers NOTHING new: a resume landing then is
// merged into a contract that can no longer observe its turn, the predecessor
// flips the record to "delivered", and turn B is stranded with no watcher and
// nothing for the boot sweep to find.

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

test("a resume landing on a watcher that already sampled its turn gets its own contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-resume-seal-"));
  const childRoomId = "terry-seal";
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

  const deliverGate = deferred(); // holds resume #1 INSIDE the parent write
  let sends = 0;
  let deliveringFirst = false;
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
      return `reply-${sends}`;
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
      if (deliveries.length === 0) {
        deliveringFirst = true;
        await deliverGate.promise;
      }
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

  assert.equal((await coordinator.resume(childRoomId, child, "m1")).tracked, true);
  for (let i = 0; i < 200 && !deliveringFirst; i += 1) await sleep(5);
  assert.equal(deliveringFirst, true, "resume #1's watcher reached the parent write");

  // Turn B lands while watcher #1 is past the point of no return.
  assert.equal((await coordinator.resume(childRoomId, child, "m2")).tracked, true);
  deliverGate.resolve();

  for (let i = 0; i < 400 && deliveries.length < 2; i += 1) await sleep(5);
  assert.equal(deliveries.length, 2, "turn B was watched and delivered too (not stranded)");
  assert.equal((await readState()).summon.resumeStatus, "delivered");
});

// RC7 red #2 (settle order): the FIRST resume's completion hook cleared the
// room's `running` / `completions` registration unconditionally. A successor
// contract armed while that watcher was sealed registers itself LATER, so the
// predecessor's settlement deleted the SUCCESSOR's registration: the parent's
// waitForDelegatedWork then sees no child in flight and can settle early, and
// a further resume finds no predecessor and arms a second watcher on the same
// turn (double delivery).
test("a settling resume never clears a newer resume's registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-resume-seq-"));
  const childRoomId = "terry-seq";
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

  const deliverGate = deferred(); // holds resume #1 inside the parent write
  const secondSettleGate = deferred(); // holds resume #2's watcher
  let sends = 0;
  let deliveringFirst = false;
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
      return `reply-${sends}`;
    },
    async waitForSettled() {
      if (sends >= 2) await secondSettleGate.promise;
    },
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
      if (deliveries.length === 0) {
        deliveringFirst = true;
        await deliverGate.promise;
      }
      deliveries.push(reply);
    },
  };

  const coordinator = new SummonCoordinator(workspace, root, async (roomId: string) => (roomId === parentRoomId ? parent : child), async () => 8, () => {});

  await coordinator.resume(childRoomId, child, "m1");
  for (let i = 0; i < 200 && !deliveringFirst; i += 1) await sleep(5);
  await coordinator.resume(childRoomId, child, "m2"); // arms a successor contract
  deliverGate.resolve();
  for (let i = 0; i < 200 && deliveries.length < 1; i += 1) await sleep(5);
  await sleep(30); // let resume #1's completion hooks run

  assert.equal(
    coordinator.runningChildren(parentRoomId).some((c) => c.roomId === childRoomId),
    true,
    "the successor resume is still registered as in-flight work of the parent",
  );
  secondSettleGate.resolve();
  for (let i = 0; i < 400 && deliveries.length < 2; i += 1) await sleep(5);
  assert.equal(deliveries.length, 2);
  assert.equal(coordinator.runningChildren(parentRoomId).length, 0, "registration is cleared once the last resume settles");
});
