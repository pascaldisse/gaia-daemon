import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseCommand } from "../src/services/commands.js";
import { loadCleanCompactionOverride, registerCleanSummary } from "../src/domain/clean-summaries.js";
import { PiCompaction } from "../src/harness/pi/compaction.js";
import { createTempDir } from "./helpers/temp.js";

test("compact-clean parser is separate; compact edit syntax unchanged", () => {
  assert.deepEqual(parseCommand("/compact-clean @gaia --summary Task → continue safely."), { type: "compact-clean", agent: "gaia", summary: "Task → continue safely." });
  assert.deepEqual(parseCommand("/compact-clean"), { type: "compact-clean", agent: undefined });
  assert.deepEqual(parseCommand("/compact-clean --summary"), { type: "compact-clean", agent: undefined, summary: "" });
  assert.deepEqual(parseCommand("/compact @gaia --edit reviewed summary"), { type: "compact", agent: "gaia", edit: "reviewed summary" });
});

test("registry preserves other rooms/agents; corrupt data and empty summaries fail closed", async () => {
  const temp = await createTempDir();
  const index = join(temp.path, "index.json");
  try {
    await writeFile(index, JSON.stringify({ other: { default: "keep" }, room: { agents: { other: "keep too" } } }));
    await registerCleanSummary("room", "gaia", "Task → continue.", index);
    assert.equal(loadCleanCompactionOverride("room", "gaia", index), "Task → continue.");
    assert.equal(loadCleanCompactionOverride("room", "other", index), "keep too");
    assert.equal(loadCleanCompactionOverride("other", "gaia", index), "keep");
    assert.equal(loadCleanCompactionOverride("nyari", "nyari", index), undefined);
    assert.equal(loadCleanCompactionOverride("toString", "gaia", index), undefined);
    await assert.rejects(registerCleanSummary("room", "gaia", " ", index));
    await writeFile(index, "broken");
    await assert.rejects(registerCleanSummary("room", "gaia", "summary", index));
    assert.equal(await readFile(index, "utf8"), "broken");
  } finally { await temp.cleanup(); }
});

test("real SDK: enabled clean hook commits newest active-branch floor; ordinary compact stays a no-op afterwards", async () => {
  const temp = await createTempDir();
  let dispose: (() => void) | undefined;
  try {
    const index = join(temp.path, "index.json");
    await registerCleanSummary("room", "gaia", "Task → verify clean compaction.", index);
    const registryBefore = await readFile(index, "utf8");
    const sessions = new Map();
    const compaction = new PiCompaction(sessions, async () => undefined, "gaia", (room, agent) => loadCleanCompactionOverride(room, agent, index));
    const loader = new DefaultResourceLoader({ cwd: temp.path, agentDir: temp.path, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
      extensionFactories: [compaction.extension("room", undefined, undefined), { name: "clean-compact", factory: compaction.cleanExtension("room") }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getExtensions().extensions.some(e => e.path === "<inline:clean-compact>"));
    const models = await ModelRuntime.create({ authPath: join(temp.path, "auth.json"), modelsPath: join(temp.path, "models.json") });
    models.setRuntimeApiKey("anthropic", "test-key-no-network");
    const model = models.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model);
    const sm = SessionManager.inMemory(temp.path);
    sm.appendMessage({ role: "user", content: "BAIT-REGRESSION ".repeat(10000), timestamp: Date.now() });
    const newest = sm.appendMessage({ role: "user", content: "Safe current task.", timestamp: Date.now() });
    sm.appendMessage({ role: "user", content: "ABANDONED-SIBLING", timestamp: Date.now() });
    sm.branch(newest);
    sm.appendModelChange(model.provider, model.id);
    const { session } = await createAgentSession({ cwd: temp.path, model, modelRuntime: models, resourceLoader: loader, sessionManager: sm, settingsManager: SettingsManager.inMemory(), tools: [] });
    dispose = () => session.dispose();
    sessions.set("room", { session });
    const result = await compaction.clean("room");
    assert.equal(result.compacted, true);
    assert.equal(result.summary, "Task → verify clean compaction.");
    const entry = sm.getLeafEntry();
    assert.equal(entry?.type, "compaction");
    if (entry?.type !== "compaction") throw Error("missing compaction");
    assert.equal(entry.firstKeptEntryId, newest);
    const context = JSON.stringify(sm.buildSessionContext());
    assert.ok(!context.includes("BAIT-REGRESSION"));
    assert.ok(!context.includes("ABANDONED-SIBLING"));
    assert.equal(session.settingsManager.getCompactionKeepRecentTokens(), 20000);
    const ordinary = await compaction.compact("room");
    assert.deepEqual(ordinary, { compacted: false, message: "nothing to compact — already compacted." });
    assert.equal(await readFile(index, "utf8"), registryBefore);
  } finally { dispose?.(); await temp.cleanup(); }
});

test("new command registers only the explicit target before dispatch; empty input never writes", async () => {
  const { runCompactCleanCommand } = await import("../src/services/room/compact-clean.js");
  const temp = await createTempDir();
  try {
    const index = join(temp.path, "index.json");
    const calls: string[] = [];
    const service = {
      roomId: "throwaway", workspace: { agents: { gaia: {} } },
      runtimes: { gaia: { capabilities: { supportsCompact: true }, compactClean: async () => ({ compacted: true, message: "clean" }) } },
      activeAgentTurn: undefined, compactingAgents: new Set<string>(),
      roomDefaultTarget: async () => "gaia", unknownAgentMessage: (id: string) => `unknown ${id}`,
      runDscCompactCommand: async (id: string) => { calls.push(id); assert.equal(loadCleanCompactionOverride("throwaway", id, index), "Task → continue."); return "clean complete"; },
    } as unknown as Parameters<typeof runCompactCleanCommand>[0];
    assert.equal(await runCompactCleanCommand(service, { type: "compact-clean", summary: "Task → continue." }, index), "clean complete");
    assert.deepEqual(calls, ["gaia"]);
    const before = await readFile(index, "utf8");
    assert.match(String(await runCompactCleanCommand(service, { type: "compact-clean", summary: " " }, index)), /Usage/);
    assert.equal(await readFile(index, "utf8"), before);
    service.compactingAgents.add("gaia");
    assert.match(String(await runCompactCleanCommand(service, { type: "compact-clean", summary: "overwrite" }, index)), /already running/);
    assert.equal(await readFile(index, "utf8"), before);
    assert.deepEqual(calls, ["gaia"]);
  } finally { await temp.cleanup(); }
});
