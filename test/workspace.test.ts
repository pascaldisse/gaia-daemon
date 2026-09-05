import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverContextFiles, ensureWorkspaceRoom } from "../src/domain/workspace.js";
import { readJson } from "../src/core/store.js";
import { workspacePaths } from "../src/core/paths.js";
import type { AgentDef } from "../src/core/types.js";
import { buildBaseSystemPrompt } from "../src/harness/prompt.js";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

async function readState(root: string, roomId: string): Promise<{ incognito?: unknown }> {
  return (await readJson(workspacePaths.roomState(root, roomId))) as { incognito?: unknown };
}

test("ensureWorkspaceRoom seeds incognito on a brand-new room", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  await ensureWorkspaceRoom(root, "vault", { incognito: true });
  assert.equal((await readState(root, "vault")).incognito, true);
});

test("ensureWorkspaceRoom leaves a normal room non-incognito", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  await ensureWorkspaceRoom(root, "lobby");
  assert.equal((await readState(root, "lobby")).incognito, undefined);
});

test("incognito is immutable: re-ensuring never flips an existing room either way", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  // A normal room stays normal even if a later select passes incognito:true.
  await ensureWorkspaceRoom(root, "lobby");
  await ensureWorkspaceRoom(root, "lobby", { incognito: true });
  assert.equal((await readState(root, "lobby")).incognito, undefined, "existing normal room never becomes incognito");

  // An incognito room stays incognito even if re-ensured without the flag.
  await ensureWorkspaceRoom(root, "vault", { incognito: true });
  await ensureWorkspaceRoom(root, "vault");
  assert.equal((await readState(root, "vault")).incognito, true, "existing incognito room never loses the flag");
});

test("concurrent ensureWorkspaceRoom keeps the first winner's seed (no create TOCTOU)", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  const statePath = workspacePaths.roomState(root, "vault");
  await mkdir(join(statePath, ".."), { recursive: true });
  // Interleave a foreign winner into the check→write gap: ensure observes a
  // missing file, the peer creates it, and a check-then-write seeder then
  // clobbers bytes it never owned. Create-if-missing must be exclusive.
  const seeding = ensureWorkspaceRoom(root, "vault", { incognito: true });
  await writeFile(statePath, `${JSON.stringify({ activeRoles: {}, agentCursors: {}, thinkingOverrides: {}, incognito: true, futureField: "first-winner" }, null, 2)}\n`, "utf8");
  await seeding;
  const state = (await readState(root, "vault")) as { incognito?: unknown; futureField?: unknown };
  assert.equal(state.futureField, "first-winner", "an existing state document is never re-created");
  assert.equal(state.incognito, true);
});

test("concurrent room seeding creates state.json exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  const statePath = workspacePaths.roomState(root, "vault");
  await mkdir(join(statePath, ".."), { recursive: true });
  // Count filesystem writes to state.json: a check-then-write seeder lets every
  // concurrent caller write (each sees the file missing), an exclusive create
  // lets exactly one through.
  let writes = 0;
  const watcher = watch(join(statePath, ".."), (_event, name) => { if (name === "state.json") writes++; });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => ensureWorkspaceRoom(root, "vault", index === 0 ? { incognito: true } : undefined)));
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  } finally {
    watcher.close();
  }
  assert.ok(writes <= 1, `state.json written ${writes} times by 8 concurrent seeders`);
});

test("ensureWorkspaceRoom never overwrites existing transcript bytes under concurrency", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  await ensureWorkspaceRoom(root, "lobby");
  const transcript = workspacePaths.transcript(root, "lobby");
  await writeFile(transcript, "{\"id\":\"e1\"}\n", "utf8");
  await Promise.all(Array.from({ length: 8 }, () => ensureWorkspaceRoom(root, "lobby")));
  assert.equal(await readFile(transcript, "utf8"), "{\"id\":\"e1\"}\n");
});

test("workspace context never inherits AGENTS.md from parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-ws-"));
  const parent = join(root, "parent");
  const workspace = join(parent, "project");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(parent, "AGENTS.md"), "parent instructions", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "workspace instructions", "utf8");

  assert.deepEqual(await discoverContextFiles(workspace), [
    { path: join(workspace, "AGENTS.md"), content: "workspace instructions" },
  ]);
});

test("buildBaseSystemPrompt reads AGENTS.md from disk at assembly time", async () => {
  // Session freezing happens in SessionMap.systemPrompt; this test exercises
  // the uncached builder directly.
  const dir = mkdtempSync(join(tmpdir(), "gaia-prompt-live-"));
  const soulPath = join(dir, "soul.md");
  writeFileSync(soulPath, "test soul");
  writeFileSync(join(dir, "AGENTS.md"), "CONTEXT-V1");
  const agent = { soulPath } as AgentDef;
  const first = await buildBaseSystemPrompt({ agent, role: undefined, workspaceRoot: dir });
  assert.ok(first.includes("CONTEXT-V1"));
  writeFileSync(join(dir, "AGENTS.md"), "CONTEXT-V2");
  const second = await buildBaseSystemPrompt({ agent, role: undefined, workspaceRoot: dir });
  assert.ok(second.includes("CONTEXT-V2"));
  assert.ok(!second.includes("CONTEXT-V1"));
});
