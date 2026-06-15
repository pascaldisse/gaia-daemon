import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceRoom, initWorkspace, isValidRoomId, setWorkspaceRoom } from "../src/workspace/workspace-loader.ts";
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
