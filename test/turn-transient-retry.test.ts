import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoomHandle } from "../src/domain/rooms.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { AgentDef, AgentEvent, RoomEvent, Task, UiEvent, Workspace } from "../src/core/types.js";
import type { AgentInput, AgentRuntime } from "../src/harness/spec.js";
import { RoomService } from "../src/services/room-service.js";
import { isTransientUpstreamError } from "../src/services/transient-upstream.js";

const INCIDENT = '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_..."}';

function agent(root: string): AgentDef {
  const dir = join(root, "agents", "gaia");
  return {
    id: "gaia",
    displayName: "Gaia",
    icon: "🤖",
    dir,
    configPath: join(dir, "agent.json"),
    personaDir: join(dir, "persona"),
    rolesDir: join(dir, "persona", "roles"),
    soulPath: join(dir, "persona", "SOUL.md"),
    memoryDir: join(dir, "persona", "memory"),
    tools: [],
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for turn state");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function makeService(makeRuntime: (agent: AgentDef, root: string) => AgentRuntime): Promise<{
  service: RoomService;
  root: string;
  events: UiEvent[];
}> {
  const root = await mkdtemp(join(process.cwd(), ".turn-transient-retry-"));
  await mkdir(join(root, ".gaia", "rooms", "default"), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8");
  const gaia = agent(root);
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia },
  };
  const service = await RoomService.open({
    workspaceId: "ws",
    workspace,
    memoryStore: new MemoryStore(),
    runtimeFactory: (configured) => makeRuntime(configured, root),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, root, events };
}

function fakeRuntime(agentDef: AgentDef, run: (input: AgentInput, attempt: number) => AsyncGenerator<AgentEvent>): AgentRuntime & { attempts: number } {
  const runtime = {
    agent: agentDef,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    attempts: 0,
    async *send(input: AgentInput): AsyncGenerator<AgentEvent> {
      runtime.attempts += 1;
      yield* run(input, runtime.attempts);
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
  };
  return runtime;
}

async function transcript(root: string): Promise<RoomEvent[]> {
  return (await (await RoomHandle.open(root, "default")).eventsFrom(0)).events;
}

test("classifies the incident overload and rejects invalid requests", () => {
  assert.equal(isTransientUpstreamError(INCIDENT), true);
  assert.equal(isTransientUpstreamError('{"type":"error","error":{"type":"invalid_request","message":"HTTP 400"}}'), false);
  assert.equal(isTransientUpstreamError("HTTP 503 service unavailable"), true);
  assert.equal(isTransientUpstreamError("HTTP 429 rate_limit_error"), true);
  assert.equal(isTransientUpstreamError("HTTP 401 authentication failed"), false);
});

test("retries a no-output overload in the same reserved turn", { timeout: 35_000 }, async () => {
  const reservedIds: string[] = [];
  let runtime: ReturnType<typeof fakeRuntime> | undefined;
  const { service, root } = await makeService((configured, workspaceRoot) => {
    runtime = fakeRuntime(configured, async function* (_input, attempt) {
      reservedIds.push((await (await RoomHandle.open(workspaceRoot, "default")).state()).pendingTurn?.eventId ?? "");
      if (attempt < 3) throw new Error(INCIDENT);
      yield { type: "text-delta", delta: "recovered reply" };
    });
    return runtime;
  });
  try {
    const task = await service.sendMessage("recover upstream");
    await waitFor(() => task.status === "complete");
    const events = await transcript(root);
    assert.equal(runtime?.attempts, 3);
    assert.deepEqual(reservedIds, [reservedIds[0], reservedIds[0], reservedIds[0]]);
    assert.equal(events.filter((event) => event.author === "gaia" && event.text === "recovered reply").length, 1);
    assert.equal(events.filter((event) => event.author === "system" && event.text.startsWith("⏳ upstream overloaded")).length, 2);
    assert.equal((await (await RoomHandle.open(root, "default")).state()).queue, undefined, "the original queue entry was consumed once");
    assert.equal((await (await RoomHandle.open(root, "default")).state()).pendingTurn, undefined);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not retry a permanent invalid request", async () => {
  let runtime: ReturnType<typeof fakeRuntime> | undefined;
  const { service, root } = await makeService((configured) => {
    runtime = fakeRuntime(configured, async function* () {
      throw new Error('{"error":{"type":"invalid_request","message":"HTTP 400"}}');
    });
    return runtime;
  });
  try {
    const task = await service.sendMessage("bad request");
    await waitFor(() => task.status === "error");
    const events = await transcript(root);
    assert.equal(runtime?.attempts, 1);
    assert.equal(events.filter((event) => event.text.startsWith("⏳ upstream overloaded")).length, 0);
    assert.ok(events.some((event) => event.text.includes("turn died without output")));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves partial output without retrying", async () => {
  let runtime: ReturnType<typeof fakeRuntime> | undefined;
  const { service, root } = await makeService((configured) => {
    runtime = fakeRuntime(configured, async function* () {
      yield { type: "text-delta", delta: "partial answer" };
      throw new Error(INCIDENT);
    });
    return runtime;
  });
  try {
    const task = await service.sendMessage("partial overload");
    await waitFor(() => task.status === "error");
    const events = await transcript(root);
    assert.equal(runtime?.attempts, 1);
    assert.equal(events.filter((event) => event.text.startsWith("⏳ upstream overloaded")).length, 0);
    assert.ok(events.some((event) => event.author === "gaia" && event.text.includes("partial answer") && event.text.includes("partial output preserved")));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling during backoff prevents the next retry", { timeout: 20_000 }, async () => {
  let runtime: ReturnType<typeof fakeRuntime> | undefined;
  const { service, root } = await makeService((configured) => {
    runtime = fakeRuntime(configured, async function* () {
      throw new Error(INCIDENT);
    });
    return runtime;
  });
  try {
    const task: Task = await service.sendMessage("cancel retry");
    await waitFor(() => (runtime?.attempts ?? 0) === 2, 10_000);
    await service.cancelActiveTask();
    await waitFor(() => task.status === "cancelled");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(runtime?.attempts, 2, "the backoff cancel prevented a third attempt");
    assert.equal((await transcript(root)).filter((event) => event.text.startsWith("⏳ upstream overloaded")).length, 1);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
