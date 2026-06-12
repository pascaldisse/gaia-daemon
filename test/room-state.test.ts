import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultRoomState, readRoomState, roomStatePath, writeRoomState } from "../src/room/state.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

test("missing room state reads as safe defaults", async () => {
  const temp = await createTempDir();
  try {
    assert.deepEqual(await readRoomState(join(temp.path, "missing.json")), defaultRoomState());
  } finally {
    await temp.cleanup();
  }
});

test("room state writes and reads active roles, cursors, and runtime details", async () => {
  const temp = await createTempDir();
  try {
    const path = join(temp.path, "rooms", "default", "state.json");
    const state = {
      activeRoles: { gaia: "brainstorm" },
      agentCursors: { gaia: 12 },
      runtimeDetails: {
        turn: {
          thinkingStarted: true,
          thinking: "checking",
          tools: [{ id: "call_1", toolName: "read", status: "complete" as const, args: { path: "AGENTS.md" }, result: { content: "ok" } }],
        },
        emptyThinking: {
          thinkingStarted: true,
        },
      },
    };

    await writeRoomState(path, state);

    assert.deepEqual(await readRoomState(path), state);
  } finally {
    await temp.cleanup();
  }
});

test("partial room state merges with defaults and filters bad values", async () => {
  const temp = await createTempDir();
  try {
    const path = join(temp.path, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        activeRoles: { gaia: "plan", sidia: "" },
        agentCursors: { gaia: 2.8, sidia: -1, terry: "bad" },
      }),
      "utf8",
    );

    assert.deepEqual(await readRoomState(path), {
      activeRoles: { gaia: "plan" },
      agentCursors: { gaia: 2 },
      runtimeDetails: {},
    });
  } finally {
    await temp.cleanup();
  }
});

test("malformed room state reads as defaults", async () => {
  const temp = await createTempDir();
  try {
    const path = join(temp.path, "state.json");
    await writeFile(path, "not json", "utf8");

    assert.deepEqual(await readRoomState(path), defaultRoomState());
  } finally {
    await temp.cleanup();
  }
});

test("workspace init and load create room state beside transcript", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  try {
    process.env.GAIA_HOME = join(temp.path, "home");
    const project = join(temp.path, "project");
    await mkdir(project, { recursive: true });
    await initWorkspace(project);

    const expectedPath = join(project, ".gaia", "rooms", "default", "state.json");
    assert.equal(existsSync(expectedPath), true);
    assert.deepEqual(JSON.parse(await readFile(expectedPath, "utf8")), defaultRoomState());

    const workspace = await loadWorkspace(project);
    assert.equal(roomStatePath(workspace.roomsDir, workspace.config.room), expectedPath);
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
