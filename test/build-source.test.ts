import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rebuildSourceRoot } from "../src/core/build-source.js";

const scratch = join(import.meta.dirname, "../.gaia/build-source-tests");
mkdirSync(scratch, { recursive: true });
function fixture(run: (root: string, git: (...args: string[]) => string) => void) {
  const root = mkdtempSync(join(scratch, "repo-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try { run(root, git); } finally { rmSync(root, { recursive: true, force: true }); }
}
function recipe(root: string) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/build-daemon.mjs"), "// recipe\n");
}

test("normal checkout and source archive retain their source", () => fixture((root, git) => {
  recipe(root);
  assert.equal(rebuildSourceRoot(root), root);
  git("init", "-q");
  assert.equal(rebuildSourceRoot(root), root);
}));

test("linked lane records shared checkout even when lane is on an old commit", () => fixture((root, git) => {
  recipe(root);
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const lane = join(root, "lane");
  git("worktree", "add", "--detach", lane, "HEAD");
  writeFileSync(join(root, "landed"), "new change"); git("add", "landed");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "landed");
  assert.equal(rebuildSourceRoot(lane), root);
  // Ephemeral lane can disappear; the recorded recipe remains reachable.
  const recorded = rebuildSourceRoot(lane);
  git("worktree", "remove", lane);
  assert.equal(rebuildSourceRoot(recorded), root);
}));

test("separate git-dir parent is not mistaken for a source checkout", () => fixture((root, git) => {
  const source = join(root, "source"); recipe(source);
  git("init", "--separate-git-dir", join(root, "metadata"), source);
  assert.equal(rebuildSourceRoot(source), source);
}));
