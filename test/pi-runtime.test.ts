import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { MemoryStore } from "../src/memory/memory-store.ts";
import { PiRuntime, piRoomSessionDir, type PiRuntimeSessionFactory, type PiSessionLike } from "../src/runtime/pi-runtime.ts";
import type { AgentEvent } from "../src/runtime/types.ts";
import type { Workspace } from "../src/workspace/types.ts";
import { createTempDir } from "./helpers/temp.ts";

class FakeSession implements PiSessionLike {
  readonly sessionId: string;
  readonly sessionFile = undefined;
  listeners: Array<(event: any) => void> = [];
  disposed = false;
  reloads = 0;
  aborts = 0;

  constructor(id: string) {
    this.sessionId = id;
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async prompt(): Promise<void> {
    for (const listener of this.listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    }
  }

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function fixture() {
  const temp = await createTempDir();
  const project = join(temp.path, "project");
  const gaiaDir = join(temp.path, "home", "agents", "gaia");
  const personaDir = join(gaiaDir, "persona");
  await mkdir(personaDir, { recursive: true });
  await mkdir(join(project, ".gaia"), { recursive: true });
  await writeFile(join(personaDir, "SOUL.md"), "Soul", "utf8");
  await writeFile(join(personaDir, "MEMORY.md"), "# Memory\n", "utf8");

  const agent: AgentDefinition = {
    id: "gaia",
    displayName: "Gaia",
    icon: "☀️",
    runtime: "pi",
    dir: gaiaDir,
    configPath: join(gaiaDir, "agent.json"),
    personaDir,
    rolesDir: join(personaDir, "roles"),
    soulPath: join(personaDir, "SOUL.md"),
    memoryPath: join(personaDir, "MEMORY.md"),
    tools: [],
  };

  const workspace: Workspace = {
    rootDir: project,
    dir: join(project, ".gaia"),
    configPath: join(project, ".gaia", "config.json"),
    agentsOverrideDir: join(project, ".gaia", "agents"),
    roomsDir: join(project, ".gaia", "rooms"),
    globalAgentsDir: join(temp.path, "home", "agents"),
    config: { defaultAgent: "gaia", room: "default", runtime: "pi", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent },
  };

  return { temp, project, workspace, agent };
}

test("pi room session directory is scoped by room and agent", async () => {
  const temp = await createTempDir();
  try {
    assert.equal(piRoomSessionDir({ roomsDir: join(temp.path, "rooms") }, "default", "gaia"), join(temp.path, "rooms", "default", "pi-sessions", "gaia"));
  } finally {
    await temp.cleanup();
  }
});

test("PiRuntime reuses one persistent session for repeated room-agent turns", async () => {
  const { temp, project, workspace, agent } = await fixture();
  try {
    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime(project, workspace, agent, new MemoryStore(), factory);

    assert.deepEqual(await collect(runtime.send({ roomId: "default", message: "one", transcript: [] })), [{ type: "text-delta", delta: "ok" }]);
    assert.deepEqual(await collect(runtime.send({ roomId: "default", message: "two", transcript: [] })), [{ type: "text-delta", delta: "ok" }]);

    assert.equal(sessions.length, 1);
    runtime.dispose();
    assert.equal(sessions[0].disposed, true);
  } finally {
    await temp.cleanup();
  }
});

test("PiRuntime reloads an existing session when prompt changes but skills do not", async () => {
  const { temp, project, workspace, agent } = await fixture();
  try {
    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime(project, workspace, agent, new MemoryStore(), factory);

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [], activeRole: { name: "plan", prompt: "A", skills: [], diagnostics: [] } }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [], activeRole: { name: "plan", prompt: "B", skills: [], diagnostics: [] } }));

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].reloads, 1);
  } finally {
    await temp.cleanup();
  }
});

test("PiRuntime recreates a session when active role skill paths change", async () => {
  const { temp, project, workspace, agent } = await fixture();
  const previousHome = process.env.GAIA_HOME;
  try {
    const home = join(temp.path, "home");
    process.env.GAIA_HOME = home;
    await mkdir(join(home, "skills", "a"), { recursive: true });
    await mkdir(join(home, "skills", "b"), { recursive: true });
    await writeFile(join(home, "skills", "a", "SKILL.md"), "# A\n", "utf8");
    await writeFile(join(home, "skills", "b", "SKILL.md"), "# B\n", "utf8");

    const sessions: FakeSession[] = [];
    const factory: PiRuntimeSessionFactory = async () => {
      const session = new FakeSession(`s${sessions.length + 1}`);
      sessions.push(session);
      return { session };
    };
    const runtime = new PiRuntime(project, workspace, agent, new MemoryStore(), factory);

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [], activeRole: { name: "a", prompt: "A", skills: ["a"], diagnostics: [] } }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [], activeRole: { name: "b", prompt: "B", skills: ["b"], diagnostics: [] } }));

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].disposed, true);
    assert.equal(sessions[1].disposed, false);
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
