import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummonCoordinator, allowSummonForTurn, isTrusted, mayNestSummon, type SummonRoomAccess } from "../src2/services/summons.js";
import { normalizeRoomState } from "../src2/domain/rooms.js";
import { readJson } from "../src2/core/store.js";
import { workspacePaths } from "../src2/core/paths.js";
import type { AgentDef, Workspace } from "../src2/core/types.js";

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "gaia",
    displayName: "Gaia",
    icon: "🌍",
    dir: "/tmp/x",
    configPath: "/tmp/x/agent.json",
    personaDir: "/tmp/x/persona",
    rolesDir: "/tmp/x/persona/roles",
    soulPath: "/tmp/x/persona/SOUL.md",
    memoryDir: "/tmp/x/persona/memory",
    tools: [],
    ...overrides,
  };
}

test("trust policy: one bit drives sandbox forcing and summon rights", () => {
  assert.equal(isTrusted(agent()), true);
  assert.equal(isTrusted(agent({ trust: false })), false);

  // Nested summons are default-deny; opt-in respected only for trusted agents.
  assert.equal(mayNestSummon(agent()), false);
  assert.equal(mayNestSummon(agent({ allowNestedSummon: true })), true);
  assert.equal(mayNestSummon(agent({ allowNestedSummon: true, trust: false })), false);

  // Top-level turns may always summon; nested only via mayNestSummon.
  assert.equal(allowSummonForTurn(agent(), false), true);
  assert.equal(allowSummonForTurn(agent(), true), false);
  assert.equal(allowSummonForTurn(agent({ allowNestedSummon: true }), true), true);
});

async function makeWorkspace(): Promise<{ workspace: Workspace; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-summons-"));
  await mkdir(join(root, ".gaia", "rooms"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  const workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "global-agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent(), terry: agent({ id: "terry" }) },
  } satisfies Workspace;
  return { workspace, path: root };
}

function fakeRoom(reply: string): SummonRoomAccess & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async sendMessage(text) {
      sent.push(text);
    },
    async waitForIdle() {},
    async latestReplyFrom() {
      return reply;
    },
  };
}

test("summon creates a linked child room and returns the worker's reply", async () => {
  const { workspace, path } = await makeWorkspace();
  const room = fakeRoom("worker says done");
  const coordinator = new SummonCoordinator(workspace, path, async () => room, 8);

  const reply = await coordinator.summonAndWait("default", "terry", "do a thing");
  assert.equal(reply, "worker says done");
  assert.equal(room.sent[0], "do a thing");

  // The child room exists on disk, stamped with its parent BEFORE first turn.
  const children = coordinator.runningChildren();
  assert.equal(children.length, 0); // settled
  const dirs = (await import("node:fs/promises")).readdir(workspace.roomsDir);
  const childId = (await dirs).find((name) => name.startsWith("terry-"));
  assert.ok(childId, "child room dir exists");
  const state = normalizeRoomState(await readJson(workspacePaths.roomState(path, childId!)));
  assert.equal(state.parentRoomId, "default");
});

test("summon refuses unknown agents and enforces the per-room cap", async () => {
  const { workspace, path } = await makeWorkspace();
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const room: SummonRoomAccess = {
    async sendMessage() {},
    async waitForIdle() {
      await blocked;
    },
    async latestReplyFrom() {
      return "ok";
    },
  };
  const coordinator = new SummonCoordinator(workspace, path, async () => room, 1);

  await assert.rejects(() => coordinator.summon("default", "nobody", "task"), /Unknown agent/);

  await coordinator.summon("default", "terry", "long task");
  assert.equal(coordinator.runningChildren("default").length, 1);
  await assert.rejects(() => coordinator.summon("default", "gaia", "another"), /Too many running summons/);
  release();
});

test("summon timeout returns a timeout message instead of hanging", async () => {
  const { workspace, path } = await makeWorkspace();
  const room: SummonRoomAccess = {
    async sendMessage() {},
    async waitForIdle() {
      throw new Error("Room is busy with another task");
    },
    async latestReplyFrom() {
      return "never read";
    },
  };
  const coordinator = new SummonCoordinator(workspace, path, async () => room, 8);
  const reply = await coordinator.summonAndWait("default", "terry", "slow");
  assert.match(reply, /timed out/);
});
