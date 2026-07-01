import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerService, type ScheduleRoomAccess, type ScheduleSummonAccess } from "../src/services/scheduler.js";
import { parseScheduleState } from "../src/domain/schedules.js";
import { workspacePaths } from "../src/core/paths.js";
import { readJson, writeJsonAtomic } from "../src/core/store.js";
import type { AgentDef, Task, Workspace } from "../src/core/types.js";
import { MEMORY_DEFAULTS } from "../src/core/config.js";

function agent(id: string): AgentDef {
  return {
    id,
    displayName: id,
    icon: "🤖",
    dir: "/tmp/x",
    configPath: "/tmp/x/agent.json",
    personaDir: "/tmp/x/persona",
    rolesDir: "/tmp/x/persona/roles",
    soulPath: "/tmp/x/persona/SOUL.md",
    memoryDir: "/tmp/x/persona/memory",
    tools: [],
  };
}

function workspaceFixture(root: string): Workspace {
  return {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "global-agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20, memory: MEMORY_DEFAULTS },
    contextFiles: [],
    agents: { gaia: agent("gaia"), terry: agent("terry") },
  };
}

class FakeRoom implements ScheduleRoomAccess {
  readonly sent: Array<{ text: string; targets: string[] }> = [];
  readonly notes: Array<{ agentId: string; text: string }> = [];
  reply = "";

  constructor(
    readonly roomId: string,
    readonly workspace: Workspace,
  ) {}

  async sendMessage(text: string, options: { targets: string[] }): Promise<Task> {
    this.sent.push({ text, targets: options.targets });
    // Settles immediately: awaitTask reads the live status.
    return { id: `task-${this.sent.length}`, roomId: this.roomId, text, targets: options.targets, status: "complete", startedAt: new Date().toISOString() };
  }

  async waitForIdle(): Promise<void> {}

  async latestReplyFrom(): Promise<string> {
    return this.reply;
  }

  async postAgentNote(agentId: string, text: string): Promise<void> {
    this.notes.push({ agentId, text });
  }

  subscribe(): () => void {
    return () => {};
  }
}

class FakeSummons implements ScheduleSummonAccess {
  readonly launched: Array<{ parentRoomId: string; agentId: string; task: string }> = [];
  reply = "summon reply";

  async launch(parentRoomId: string, agentId: string, task: string): Promise<{ roomId: string; done: Promise<string> }> {
    this.launched.push({ parentRoomId, agentId, task });
    return { roomId: `child-${this.launched.length}`, done: Promise.resolve(this.reply) };
  }
}

interface Fixture {
  root: string;
  scheduler: SchedulerService;
  rooms: Map<string, FakeRoom>;
  summons: FakeSummons;
  clock: { now: Date };
  state(): Promise<ReturnType<typeof parseScheduleState>>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "gaia-scheduler-"));
  await mkdir(join(root, ".gaia"), { recursive: true });
  const workspace = workspaceFixture(root);
  const rooms = new Map<string, FakeRoom>();
  const roomFor = (roomId: string): FakeRoom => {
    let room = rooms.get(roomId);
    if (!room) {
      room = new FakeRoom(roomId, workspace);
      rooms.set(roomId, room);
    }
    return room;
  };
  const summons = new FakeSummons();
  const clock = { now: new Date("2026-07-01T08:00:00Z") };
  const scheduler = new SchedulerService({
    listWorkspaces: async () => [{ id: "ws", path: root }],
    serviceFor: async (_workspaceId, roomId) => roomFor(roomId ?? "default"),
    summonHost: async () => summons,
    now: () => clock.now,
  });
  return {
    root,
    scheduler,
    rooms,
    summons,
    clock,
    state: async () => parseScheduleState(await readJson(workspacePaths.scheduleState(root))),
  };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

test("fresh jobs seed on first sight and fire at the NEXT instant, once", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "poll", schedule: "every 30m", prompt: "check the queue" }],
  });

  await f.scheduler.tick();
  assert.equal(f.summons.launched.length, 0, "seeding must not dispatch");
  assert.ok((await f.state()).poll?.lastRunAt, "state seeded");

  // 31 minutes later: due exactly once, even after several ticks.
  f.clock.now = new Date("2026-07-01T08:31:00Z");
  await f.scheduler.tick();
  await waitFor(async () => (await f.state()).poll?.status === "complete");
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(f.summons.launched.length, 1);

  // Isolated by default: launched against the deliver room, result posted there.
  assert.equal(f.summons.launched[0].parentRoomId, "default");
  assert.equal(f.summons.launched[0].agentId, "gaia", "defaults to the workspace default agent");
  assert.match(f.summons.launched[0].task, /Scheduled task `poll`/);
  assert.match(f.summons.launched[0].task, /check the queue/);
  const notes = f.rooms.get("default")?.notes ?? [];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /⏰ `poll`/);
  assert.match(notes[0].text, /summon reply/);

  const record = (await f.state()).poll;
  assert.equal(record?.lastOutput, "summon reply");
  assert.equal(record?.runRoomId, "child-1");
  assert.equal(record?.deliverRoomId, "default");
});

test("room-mode job runs as a normal targeted message in its room", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "journal", schedule: "every 1h", prompt: "append the log", agent: "terry", room: "ops", isolated: false }],
  });
  await f.scheduler.tick();
  f.clock.now = new Date("2026-07-01T09:01:00Z");
  await f.scheduler.tick();
  await waitFor(async () => (await f.state()).journal?.status === "complete");

  assert.equal(f.summons.launched.length, 0);
  const room = f.rooms.get("ops");
  assert.equal(room?.sent.length, 1);
  assert.deepEqual(room?.sent[0].targets, ["terry"]);
  assert.match(room!.sent[0].text, /append the log/);
  assert.equal((await f.state()).journal?.runRoomId, "ops");
});

test("chainOutput feeds the previous run's output into the prompt", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "digest", schedule: "every 30m", prompt: "continue the digest", chainOutput: true }],
  });
  await writeJsonAtomic(workspacePaths.scheduleState(f.root), {
    digest: { lastRunAt: "2026-07-01T07:00:00Z", status: "complete", lastEndedAt: "2026-07-01T07:02:00Z", lastOutput: "yesterday: shipped memory v3" },
  });

  await f.scheduler.tick();
  await waitFor(() => f.summons.launched.length === 1);
  assert.match(f.summons.launched[0].task, /Output of the previous run \(2026-07-01T07:02:00Z\)/);
  assert.match(f.summons.launched[0].task, /yesterday: shipped memory v3/);
});

test("kill switches: file-level enabled:false and per-job enabled:false", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    enabled: false,
    jobs: [{ id: "never", schedule: "every 1m", prompt: "x" }],
  });
  await f.scheduler.tick();
  f.clock.now = new Date("2026-07-01T12:00:00Z");
  await f.scheduler.tick();
  assert.equal(f.summons.launched.length, 0);

  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "never", schedule: "every 1m", prompt: "x", enabled: false }],
  });
  await f.scheduler.tick();
  f.clock.now = new Date("2026-07-01T18:00:00Z");
  await f.scheduler.tick();
  assert.equal(f.summons.launched.length, 0);
});

test("runNow forces a run regardless of schedule; unknown ids answer politely", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "report", schedule: "@daily", prompt: "write the report" }],
  });
  const message = await f.scheduler.runNow("ws", f.root, "report");
  assert.match(message, /Started scheduled job 'report'/);
  await waitFor(() => f.summons.launched.length === 1);

  assert.match(await f.scheduler.runNow("ws", f.root, "ghost"), /Unknown scheduled job/);
});

test("recovery: a run marked running by a dead process is reopened and delivered", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "long", schedule: "@daily", prompt: "x" }],
  });
  await writeJsonAtomic(workspacePaths.scheduleState(f.root), {
    long: { lastRunAt: "2026-07-01T07:00:00Z", status: "running", runRoomId: "child-99", deliverRoomId: "default", agentId: "gaia" },
  });
  // The reply the interrupted turn (resumed via the room WAL) left behind.
  const fakeChild = new FakeRoom("child-99", workspaceFixture(f.root));
  fakeChild.reply = "recovered result";
  f.rooms.set("child-99", fakeChild);

  await f.scheduler.tick();
  await waitFor(async () => (await f.state()).long?.status === "complete");
  const notes = f.rooms.get("default")?.notes ?? [];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /recovered after restart/);
  assert.match(notes[0].text, /recovered result/);
  assert.equal((await f.state()).long?.lastOutput, "recovered result");
});

test("recovery with no dispatch mark ends as interrupted, not re-run", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "edge", schedule: "@daily", prompt: "x" }],
  });
  await writeJsonAtomic(workspacePaths.scheduleState(f.root), {
    edge: { lastRunAt: "2026-07-01T07:59:59Z", status: "running" },
  });
  await f.scheduler.tick();
  await waitFor(async () => (await f.state()).edge?.status === "interrupted");
  assert.equal(f.summons.launched.length, 0);
  assert.match((await f.state()).edge?.lastError ?? "", /restarted before the run was dispatched/);
});

test("state for jobs removed from the file is pruned", async () => {
  const f = await fixture();
  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [{ id: "keep", schedule: "@daily", prompt: "x" }],
  });
  await writeJsonAtomic(workspacePaths.scheduleState(f.root), {
    keep: { lastRunAt: "2026-07-01T07:00:00Z", status: "complete" },
    gone: { lastRunAt: "2026-06-01T07:00:00Z", status: "complete" },
  });
  await f.scheduler.tick();
  const state = await f.state();
  assert.ok(state.keep);
  assert.equal(state.gone, undefined);
});

test("describeWorkspace lists jobs with status and next instant", async () => {
  const f = await fixture();
  assert.match(await f.scheduler.describeWorkspace("ws", f.root), /No scheduled jobs/);

  await writeJsonAtomic(workspacePaths.schedules(f.root), {
    jobs: [
      { id: "digest", schedule: "every 30m", prompt: "x" },
      { id: "off", schedule: "@daily", prompt: "y", enabled: false },
    ],
  });
  await writeJsonAtomic(workspacePaths.scheduleState(f.root), {
    digest: { lastRunAt: "2026-07-01T07:45:00Z", status: "complete", lastEndedAt: "2026-07-01T07:46:00Z" },
  });
  const listing = await f.scheduler.describeWorkspace("ws", f.root);
  assert.match(listing, /● digest — every 30m/);
  assert.match(listing, /last: complete at 2026-07-01T07:46:00Z/);
  assert.match(listing, /next: 2026-07-01T08:15:00\.000Z/);
  assert.match(listing, /○ off — @daily/);
  assert.match(listing, /disabled/);
});
