// Adversarial contract tests for initial room creation. Written against the
// public API only (ensureWorkspaceRoom), so they survive the move of the room
// layout out of workspace-loader into RoomLifecycle/RoomStore.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonText } from "../src/lib/fs.ts";
import { defaultRoomState } from "../src/room/state.ts";
import { ensureWorkspaceRoom, initWorkspace, WORKSPACE_DIRNAME } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

function roomFiles(cwd: string, roomId: string): { dir: string; transcript: string; state: string } {
  const dir = join(cwd, WORKSPACE_DIRNAME, "rooms", roomId);
  return { dir, transcript: join(dir, "transcript.jsonl"), state: join(dir, "state.json") };
}

test("ensureWorkspaceRoom writes the byte-exact default state", async () => {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);
    await ensureWorkspaceRoom(temp.path, "lab");
    const { state } = roomFiles(temp.path, "lab");
    assert.equal(await readFile(state, "utf8"), jsonText(defaultRoomState()));
  } finally {
    await temp.cleanup();
  }
});

test("ensureWorkspaceRoom never rewrites existing transcript or state", async () => {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);
    const { dir, transcript, state } = roomFiles(temp.path, "lab");
    await mkdir(dir, { recursive: true });
    const transcriptBody = `${JSON.stringify({ id: 1, kind: "message", text: "keep me" })}\n`;
    const stateBody = jsonText({ ...defaultRoomState(), lastEventId: 1, activeRoles: { luna: "builder" } });
    await writeFile(transcript, transcriptBody, "utf8");
    await writeFile(state, stateBody, "utf8");

    await ensureWorkspaceRoom(temp.path, "lab");
    await ensureWorkspaceRoom(temp.path, "lab");

    assert.equal(await readFile(transcript, "utf8"), transcriptBody);
    assert.equal(await readFile(state, "utf8"), stateBody);
  } finally {
    await temp.cleanup();
  }
});

test("ensureWorkspaceRoom repairs a partially created room without touching the survivor", async () => {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);

    // case A: transcript exists, state missing
    const a = roomFiles(temp.path, "half-a");
    await mkdir(a.dir, { recursive: true });
    const body = `${JSON.stringify({ id: 7, kind: "message" })}\n`;
    await writeFile(a.transcript, body, "utf8");
    await ensureWorkspaceRoom(temp.path, "half-a");
    assert.equal(await readFile(a.transcript, "utf8"), body);
    assert.equal(await readFile(a.state, "utf8"), jsonText(defaultRoomState()));

    // case B: state exists, transcript missing
    const b = roomFiles(temp.path, "half-b");
    await mkdir(b.dir, { recursive: true });
    const stateBody = jsonText({ ...defaultRoomState(), lastEventId: 42 });
    await writeFile(b.state, stateBody, "utf8");
    await ensureWorkspaceRoom(temp.path, "half-b");
    assert.equal(await readFile(b.state, "utf8"), stateBody);
    assert.equal(await readFile(b.transcript, "utf8"), "");
  } finally {
    await temp.cleanup();
  }
});

test("ensureWorkspaceRoom creates missing parent directories (ENOENT workspace)", async () => {
  const temp = await createTempDir();
  try {
    // no initWorkspace: .gaia/ and .gaia/rooms/ do not exist yet
    const { transcript, state } = roomFiles(temp.path, "fresh");
    assert.equal(existsSync(join(temp.path, WORKSPACE_DIRNAME)), false);
    await ensureWorkspaceRoom(temp.path, "fresh");
    assert.equal(await readFile(transcript, "utf8"), "");
    assert.equal(await readFile(state, "utf8"), jsonText(defaultRoomState()));
  } finally {
    await temp.cleanup();
  }
});

test("concurrent ensureWorkspaceRoom calls neither fail nor clobber", async () => {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);
    await Promise.all(Array.from({ length: 24 }, () => ensureWorkspaceRoom(temp.path, "race")));
    const { transcript, state } = roomFiles(temp.path, "race");
    assert.equal(await readFile(transcript, "utf8"), "");
    assert.equal(await readFile(state, "utf8"), jsonText(defaultRoomState()));

    // a second wave must not touch content written in between
    const body = `${JSON.stringify({ id: 1, kind: "message" })}\n`;
    await writeFile(transcript, body, "utf8");
    await Promise.all(Array.from({ length: 24 }, () => ensureWorkspaceRoom(temp.path, "race")));
    assert.equal(await readFile(transcript, "utf8"), body);
  } finally {
    await temp.cleanup();
  }
});
