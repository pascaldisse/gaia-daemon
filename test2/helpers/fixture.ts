// Shared harness-test fixture: a temp workspace + one agent with a real
// persona/memory layout on disk (the REAL MemoryStore reads it), and a temp
// GAIA_HOME so nothing touches the user's ~/.gaia.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDef, AgentEvent, Workspace } from "../../src2/core/types.js";
import { createTempDir, type TempDir } from "./temp.js";

export interface HarnessFixture {
  temp: TempDir;
  project: string;
  home: string;
  workspace: Workspace;
  agent: AgentDef;
  cleanup(): Promise<void>;
}

export async function harnessFixture(
  overrides: Partial<Pick<AgentDef, "tools" | "model" | "harness" | "thinking" | "permissionMode">> = {},
): Promise<HarnessFixture> {
  const temp = await createTempDir();
  const project = join(temp.path, "project");
  const home = join(temp.path, "home");
  const gaiaDir = join(home, "agents", "gaia");
  const personaDir = join(gaiaDir, "persona");
  await mkdir(personaDir, { recursive: true });
  await mkdir(join(project, ".gaia"), { recursive: true });
  await writeFile(join(personaDir, "SOUL.md"), "Soul", "utf8");
  await mkdir(join(personaDir, "memory"), { recursive: true });
  await writeFile(join(personaDir, "memory", "MEMORY.md"), "# Memory\n", "utf8");

  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;

  const agent: AgentDef = {
    id: "gaia",
    displayName: "Gaia",
    icon: "☀️",
    dir: gaiaDir,
    configPath: join(gaiaDir, "agent.json"),
    personaDir,
    rolesDir: join(personaDir, "roles"),
    soulPath: join(personaDir, "SOUL.md"),
    memoryDir: join(personaDir, "memory"),
    tools: [],
    ...overrides,
  };

  const workspace: Workspace = {
    rootDir: project,
    dir: join(project, ".gaia"),
    configPath: join(project, ".gaia", "config.json"),
    agentsOverrideDir: join(project, ".gaia", "agents"),
    roomsDir: join(project, ".gaia", "rooms"),
    globalAgentsDir: join(home, "agents"),
    config: { defaultAgent: "gaia", room: "default", transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent },
  };

  return {
    temp,
    project,
    home,
    workspace,
    agent,
    cleanup: async () => {
      if (previousHome === undefined) delete process.env.GAIA_HOME;
      else process.env.GAIA_HOME = previousHome;
      await temp.cleanup();
    },
  };
}

export async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
