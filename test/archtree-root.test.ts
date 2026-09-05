import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { addArchtreeRoot } from "../src/services/archtree.js";
import type { SummonHost, SummonOptions } from "../src/services/summons.js";

const scratch = join(import.meta.dir, "../.gaia/archtree-tests");

test("root launch carries the installed skill, reloads edits, and preserves siblings", async () => {
  await mkdir(scratch, { recursive: true });
  const rootDir = await mkdtemp(join(scratch, "root-"));
  const workspace = { rootDir, dir: join(rootDir, ".gaia") };
  const skillDir = join(workspace.dir, "skills/gaia-archtree");
  await mkdir(skillDir, { recursive: true });
  const calls: { parent: string; agent: string; task: string; options?: SummonOptions }[] = [];
  const host: Pick<SummonHost, "summon"> = {
    async summon(parent, agent, task, options) {
      calls.push({ parent, agent, task, options });
      return `root-${calls.length}`;
    },
  };
  try {
    await writeFile(join(skillDir, "SKILL.md"), "# Installed archtree\nbun only · own worktree · BUILD + ADVERSARY\n");
    for (const task of ["BUILD recon", "ADVERSARY recon"]) {
      await addArchtreeRoot(host, { workspace, parentRoomId: "coordinator", agentId: "worker", task });
    }
    const before = structuredClone(calls);
    await writeFile(join(skillDir, "SKILL.md"), "# Installed archtree\nUPDATED LAW · laws → every child\n");
    expect(await addArchtreeRoot(host, { workspace, parentRoomId: "coordinator", agentId: "other", task: "orthogonal", callerAgentId: "monad" })).toBe("root-3");
    expect(calls.slice(0, 2)).toEqual(before);
    expect(calls[0].task).toContain("bun only · own worktree · BUILD + ADVERSARY");
    expect(calls[2].task).toContain("UPDATED LAW");
    expect(calls[2].task).toContain("orthogonal");
    expect(calls.map((call) => call.parent)).toEqual(["coordinator", "coordinator", "coordinator"]);
    expect(calls[0].options).toEqual({ deliver: "note", ownWorktree: true });
    expect(calls[2].options).toEqual({ deliver: "turn", callerAgentId: "monad", ownWorktree: true });
    await expect(addArchtreeRoot(host, { workspace, parentRoomId: "coordinator", agentId: "worker", task: " " })).rejects.toThrow("Usage");
    expect(calls).toHaveLength(3);
    await rm(join(skillDir, "SKILL.md"));
    await mkdir(join(skillDir, "SKILL.md"));
    await expect(addArchtreeRoot(host, { workspace, parentRoomId: "coordinator", agentId: "worker", task: "cannot run without laws" })).rejects.toThrow("Archtree skill unavailable");
    expect(calls).toHaveLength(3);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
