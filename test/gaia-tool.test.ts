import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGaiaTool } from "../src/harness/tools-pi.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { AgentDef } from "../src/core/types.js";

function text(result: any): string {
  return result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
}

test("gaia-only tool dispatches every phase-one verb to its native implementation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-tool-"));
  const memoryDir = join(dir, "memory");
  await mkdir(memoryDir);
  const file = join(dir, "note.txt");
  const caryll = join(dir, "caryll.txt");
  await writeFile(caryll, "same phrase repeats. same phrase repeats. same phrase repeats.\n");
  const calls: string[] = [];
  const agent = { id: "only-gaia", memoryDir, insight: "none" } as AgentDef;
  const tool: any = createGaiaTool({
    memoryStore: new MemoryStore(),
    agent,
    roomId: "r1",
    roomDir: dir,
    workDir: dir,
    availableAgents: [{ id: "worker", label: "Worker" }],
    summonCreate: async ({ agentId, task }: { agentId: string; task: string }) => {
      calls.push(`summon:${agentId}:${task}`);
      return "summoned";
    },
    resumeCreate: async ({ roomId, message }: { roomId: string; message: string }) => {
      calls.push(`resume:${roomId}:${message}`);
      return "resumed";
    },
  });

  assert.equal(tool.name, "gaia");
  await tool.execute("w", { verb: "write", args: { path: file, content: "before" }, raw: true });
  assert.equal(await readFile(file, "utf8"), "before");
  assert.match(text(await tool.execute("r", { verb: "read", args: { path: file }, raw: true })), /before/);
  await tool.execute("e", { verb: "edit", args: { path: file, edits: [{ oldText: "before", newText: "after" }] }, raw: true });
  assert.equal(await readFile(file, "utf8"), "after");
  assert.match(text(await tool.execute("b", { verb: "bash", args: { command: "printf bash-ok" }, raw: true })), /bash-ok/);
  assert.match(text(await tool.execute("web", { verb: "web", args: { command: "printf web-curl-fallback" }, raw: true })), /web-curl-fallback/);
  assert.match(text(await tool.execute("mem", { verb: "mem", args: { action: "list" }, raw: true })), /no memory files/);
  assert.match(text(await tool.execute("recall", { verb: "recall", args: { query: "nothing" }, raw: true })), /no matches|ERROR/);
  assert.equal(text(await tool.execute("summon", { verb: "summon", args: { agent: "worker", task: "map" }, raw: true })), "summoned");
  assert.equal(text(await tool.execute("resume", { verb: "resume", args: { roomId: "child", message: "steer" }, raw: true })), "resumed");
  assert.match(text(await tool.execute("c", { verb: "caryll", args: { action: "stats", path: caryll }, raw: true })), /caryll\.stats/);
  assert.deepEqual(calls, ["summon:worker:map", "resume:child:steer"]);
});

test("gaia formats above the configurable threshold in deterministic gaiago and raw bypasses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-format-"));
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const formatted = text(await tool.execute("f", { verb: "bash", args: { command: "printf 'one\\n\\n two\\n'" }, compress_above_bytes: 0 }));
  assert.match(formatted, /^真 bash · 行=2/);
  assert.match(formatted, /1→one\n2→two/);
  const raw = text(await tool.execute("raw", { verb: "bash", args: { command: "printf one" }, compress_above_bytes: 0, raw: true }));
  assert.equal(raw, "one");
});
