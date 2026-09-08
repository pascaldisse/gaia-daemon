import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initWorkspace, loadWorkspace } from "../src/domain/workspace.js";
import { resolveAutoCompactConfig } from "../src/services/room/auto-compact.js";
import { createTempDir } from "./helpers/temp.js";

test("real workspace loading inherits global policy; fresh init does not pin legacy off", async () => {
  const temp = await createTempDir("gaia-auto-compact-workspace-");
  const previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "global");
  const project = join(temp.path, "project");
  const configPath = join(project, ".gaia", "config.json");
  try {
    await mkdir(process.env.GAIA_HOME, { recursive: true });
    await writeFile(join(process.env.GAIA_HOME, "config.json"), JSON.stringify({
      autoCompact: { thresholdTokens: 170_000, cooldownTurns: 3, modelOverrides: { provider: { model: { thresholdPct: 80 } } } },
      env: { AUTO_COMPACT_INHERITANCE_PROBE: "global" },
      room: "must-not-leak",
    }));
    await initWorkspace(project);
    const scaffold = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(scaffold.autoCompact, undefined);
    const inherited = await loadWorkspace(project);
    assert.equal(inherited.config.autoCompact.thresholdTokens, 170_000);
    assert.equal(inherited.config.autoCompact.cooldownTurns, 3);
    assert.equal(inherited.config.env?.AUTO_COMPACT_INHERITANCE_PROBE, "global");
    assert.notEqual(inherited.config.room, "must-not-leak");
    const model = { provider: "provider", model: "model" };
    assert.equal(resolveAutoCompactConfig(inherited.config.autoCompact, undefined, model).thresholdPct, 80);

    await writeFile(configPath, JSON.stringify({ ...scaffold, autoCompact: { cooldownTurns: 2, modelOverrides: { provider: { model: { thresholdTokens: 155_000 } } } } }));
    const patched = (await loadWorkspace(project)).config.autoCompact;
    assert.equal(patched.thresholdTokens, 170_000);
    assert.equal(patched.cooldownTurns, 2);
    assert.equal(resolveAutoCompactConfig(patched, undefined, model).thresholdTokens, 155_000);
    assert.equal(resolveAutoCompactConfig(patched, undefined, model).thresholdPct, null);

    for (const autoCompact of [{ thresholdPct: null }, { thresholdTokens: null }]) {
      await writeFile(configPath, JSON.stringify({ ...scaffold, autoCompact }));
      const disabled = (await loadWorkspace(project)).config.autoCompact;
      assert.equal(disabled.thresholdPct, null);
      assert.ok(disabled.thresholdTokens == null);
    }
    await writeFile(configPath, JSON.stringify({ ...scaffold, autoCompact: { thresholdPct: 25 } }));
    assert.equal((await loadWorkspace(project)).config.autoCompact.thresholdTokens, undefined);
    await writeFile(configPath, JSON.stringify({ ...scaffold, autoCompact: { thresholdTokens: -1 } }));
    assert.equal((await loadWorkspace(project)).config.autoCompact.thresholdTokens, 170_000);

    await writeFile(join(process.env.GAIA_HOME, "config.json"), "{}");
    await writeFile(configPath, JSON.stringify(scaffold));
    assert.equal((await loadWorkspace(project)).config.autoCompact.thresholdTokens, 180_000);
  } finally {
    if (previous === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previous;
    await temp.cleanup();
  }
});
