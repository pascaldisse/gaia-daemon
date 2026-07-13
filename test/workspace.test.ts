import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverContextFiles, ensureWorkspaceRoom } from "../src/domain/workspace.js";
import { readJson } from "../src/core/store.js";
import { workspacePaths } from "../src/core/paths.js";

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
