import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scaffoldGlobalAgent } from "../src/agents/scaffold.ts";
import { createTempDir } from "./helpers/temp.ts";

test("scaffolds a global agent persona folder without role stubs", async () => {
  const temp = await createTempDir();
  try {
    const result = await scaffoldGlobalAgent(join(temp.path, "agents"), "luma", { displayName: "Luma" });

    assert.equal(existsSync(result.configPath), true);
    assert.equal(existsSync(result.soulPath), true);
    assert.equal(existsSync(join(result.memoryDir, "MEMORY.md")), true);
    assert.equal(existsSync(join(result.memoryDir, "USER.md")), true);
    // Roles directory exists but is empty: roles are user-added only.
    assert.equal(existsSync(result.rolesDir), true);

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    assert.deepEqual(config, {
      id: "luma",
      displayName: "Luma",
      icon: "•",
      thinking: "medium",
      tools: ["read", "write", "edit", "memory", "recall"],
      harness: "pi",
      model: { provider: "deepseek", name: "deepseek-v4-pro" },
    });
  } finally {
    await temp.cleanup();
  }
});

test("agent scaffold refuses to overwrite existing agents", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    await scaffoldGlobalAgent(agentsDir, "luma");
    await assert.rejects(() => scaffoldGlobalAgent(agentsDir, "luma"), /Agent already exists/);
  } finally {
    await temp.cleanup();
  }
});

test("agent scaffold rejects unsafe ids", async () => {
  const temp = await createTempDir();
  try {
    await assert.rejects(() => scaffoldGlobalAgent(join(temp.path, "agents"), "../bad"), /Invalid agent id/);
  } finally {
    await temp.cleanup();
  }
});
