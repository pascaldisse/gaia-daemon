import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceRoom, initWorkspace, isValidRoomId, setWorkspaceRoom, gaiaHome, globalAgentsPath } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

test("isValidRoomId accepts legal ids", () => {
  const legal = ["default", "r", "room1", "my-room", "a.b", "x_y", "abc123", "A", "Z"].concat(
    // 64-char max id
    "a".repeat(64),
  );
  for (const id of legal) {
    assert.ok(isValidRoomId(id), `Expected valid: ${id}`);
  }
});

test("isValidRoomId rejects empty, too long, or bad chars", () => {
  const illegal = [
    "",
    "a".repeat(65), // too long
    ".hidden",
    "..",
    "has/slash",
    "has space",
    "-starts-with-hyphen",
    "_underscore-start?",
  ];
  for (const id of illegal) {
    assert.ok(!isValidRoomId(id), `Expected invalid: ${id}`);
  }
});

test("ensureWorkspaceRoom creates transcript and state files", async () => {
  const temp = await createTempDir();
  try {
    const ws = await initWorkspace(temp.path);
    await ensureWorkspaceRoom(temp.path, "lab");

    const transcriptPath = join(ws.workspaceDir, "rooms", "lab", "transcript.jsonl");
    const statePath = join(ws.workspaceDir, "rooms", "lab", "state.json");

    assert.ok(existsSync(transcriptPath));
    assert.ok(existsSync(statePath));
    assert.equal(await readFile(transcriptPath, "utf8"), "");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(state && typeof state === "object");
    assert.ok("activeRoles" in state);
  } finally {
    await temp.cleanup();
  }
});

test("ensureWorkspaceRoom rejects invalid room ids", async () => {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);
    await assert.rejects(() => ensureWorkspaceRoom(temp.path, "../escape"), /Room id must be/);
    await assert.rejects(() => ensureWorkspaceRoom(temp.path, ""), /Room id must be/);
    await assert.rejects(() => ensureWorkspaceRoom(temp.path, "bad/slash"), /Room id must be/);
  } finally {
    await temp.cleanup();
  }
});

test("setWorkspaceRoom updates config.room", async () => {
  const temp = await createTempDir();
  try {
    const ws = await initWorkspace(temp.path);
    await setWorkspaceRoom(temp.path, "lab");

    const config = JSON.parse(await readFile(join(ws.workspaceDir, "config.json"), "utf8"));
    assert.equal(config.room, "lab");
  } finally {
    await temp.cleanup();
  }
});

test("setWorkspaceRoom rejects invalid room ids", async () => {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);
    await assert.rejects(() => setWorkspaceRoom(temp.path, ""), /Room id must be/);
    await assert.rejects(() => setWorkspaceRoom(temp.path, "bad/slash"), /Room id must be/);
  } finally {
    await temp.cleanup();
  }
});

// gaiaHome() empty/whitespace guard

test("gaiaHome falls back to ~/.gaia when GAIA_HOME unset", () => {
  const original = process.env.GAIA_HOME;
  delete process.env.GAIA_HOME;
  try {
    const home = gaiaHome();
    assert.ok(home.endsWith(".gaia"), `Expected ~/.gaia fallback, got ${home}`);
  } finally {
    if (original !== undefined) process.env.GAIA_HOME = original;
  }
});

test("gaiaHome falls back to ~/.gaia when GAIA_HOME=''", () => {
  const original = process.env.GAIA_HOME;
  process.env.GAIA_HOME = "";
  try {
    const home = gaiaHome();
    assert.ok(home.endsWith(".gaia"), `Expected ~/.gaia fallback, got ${home}`);
  } finally {
    if (original !== undefined) process.env.GAIA_HOME = original;
  }
});

test("gaiaHome falls back to ~/.gaia when GAIA_HOME is whitespace", () => {
  const original = process.env.GAIA_HOME;
  process.env.GAIA_HOME = "   ";
  try {
    const home = gaiaHome();
    assert.ok(home.endsWith(".gaia"), `Expected ~/.gaia fallback, got ${home}`);
  } finally {
    if (original !== undefined) process.env.GAIA_HOME = original;
  }
});

test("gaiaHome uses explicit GAIA_HOME value", () => {
  const original = process.env.GAIA_HOME;
  process.env.GAIA_HOME = "/explicit/gaia/path";
  try {
    const home = gaiaHome();
    assert.equal(home, "/explicit/gaia/path");
  } finally {
    if (original !== undefined) process.env.GAIA_HOME = original;
  }
});

test("globalAgentsPath derives from gaiaHome", () => {
  const path = globalAgentsPath("/some/home");
  assert.ok(path.endsWith("agents"), `Expected .../agents, got ${path}`);
  assert.ok(path.startsWith("/some/home"), `Expected /some/home prefix, got ${path}`);
});

test("globalAgentsPath defaults to gaiaHome()/agents", () => {
  const original = process.env.GAIA_HOME;
  process.env.GAIA_HOME = "/custom/gaia";
  try {
    const path = globalAgentsPath();
    assert.equal(path, "/custom/gaia/agents");
  } finally {
    if (original !== undefined) process.env.GAIA_HOME = original;
  }
});

test("globalAgentsPath with empty string home falls back to gaiaHome default", () => {
  // Pass empty string directly → gaiaHome() called, but our guard is in gaiaHome(), not here.
  // This tests the default-param path: when called with no arg.
  const original = process.env.GAIA_HOME;
  delete process.env.GAIA_HOME;
  try {
    const path = globalAgentsPath();
    assert.ok(path.endsWith("/agents"), `Expected .../agents, got ${path}`);
    assert.ok(path.includes(".gaia"), `Expected .gaia base, got ${path}`);
  } finally {
    if (original !== undefined) process.env.GAIA_HOME = original;
  }
});

test("loadWorkspace parses harness from config.json", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  try {
    await initWorkspace(temp.path);
    const { loadWorkspace } = await import("../src/workspace/workspace-loader.ts");

    // Default: no harness
    let ws = await loadWorkspace(temp.path);
    assert.equal(ws.config.harness, undefined);

    // Set harness to codex
    await writeFile(join(temp.path, ".gaia", "config.json"), JSON.stringify({ defaultAgent: "gaia", harness: "codex" }), "utf8");
    ws = await loadWorkspace(temp.path);
    assert.equal(ws.config.harness, "codex");

    // Set harness to pi
    await writeFile(join(temp.path, ".gaia", "config.json"), JSON.stringify({ defaultAgent: "gaia", harness: "pi" }), "utf8");
    ws = await loadWorkspace(temp.path);
    assert.equal(ws.config.harness, "pi");

    // Invalid value is ignored
    await writeFile(join(temp.path, ".gaia", "config.json"), JSON.stringify({ defaultAgent: "gaia", harness: "invalid" }), "utf8");
    ws = await loadWorkspace(temp.path);
    assert.equal(ws.config.harness, undefined);
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});
