// Room worktree isolation (domain/worktree.ts + collab config): the git layer
// that gives each summon room its own checkout. Real git against a scratch
// repo in tmpdir — the failure modes that matter here (stale dirs, missing
// .git links, non-repo workspaces) only exist on a real filesystem.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCollabConfig } from "../src/core/config.js";
import { workspacePaths } from "../src/core/paths.js";
import { normalizeRoomState } from "../src/domain/rooms.js";
import { ensureRoomWorktree, isGitRepo, removeRoomWorktree, roomBranch } from "../src/domain/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A scratch git repo with one commit — the minimum a worktree can branch off. */
async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gaia-worktree-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  await writeFile(join(root, "README.md"), "scratch\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}

// --- config parsing ---------------------------------------------------------

test("parseCollabConfig: worktree isolation, defaults, legacy spellings, garbage", () => {
  assert.deepEqual(parseCollabConfig({ isolation: "worktree", branchPrefix: "x/" }), { isolation: "worktree", branchPrefix: "x/" });
  // branchPrefix defaults when absent/blank.
  assert.deepEqual(parseCollabConfig({ isolation: "worktree" }), { isolation: "worktree", branchPrefix: "gaia/" });
  assert.deepEqual(parseCollabConfig({ isolation: "worktree", branchPrefix: "  " }), { isolation: "worktree", branchPrefix: "gaia/" });
  // Legacy spellings from the feature's first iteration keep working.
  assert.deepEqual(parseCollabConfig({ isolation: "worktree-per-room" }), { isolation: "worktree", branchPrefix: "gaia/" });
  assert.deepEqual(parseCollabConfig({ isolation: "worktree-per-summon" }), { isolation: "worktree", branchPrefix: "gaia/" });
  assert.deepEqual(parseCollabConfig({ isolation: "shared" }), { isolation: "shared", branchPrefix: "gaia/" });
  // Garbage → undefined (= shared behavior), never a throw.
  assert.equal(parseCollabConfig(undefined), undefined);
  assert.equal(parseCollabConfig("worktree"), undefined);
  assert.equal(parseCollabConfig({ isolation: "banana" }), undefined);
  assert.equal(parseCollabConfig({}), undefined);
});

test("normalizeRoomState preserves a stamped workDir and drops blank ones", () => {
  assert.equal(normalizeRoomState({ workDir: "/tmp/ws/.gaia/worktrees/r1" }).workDir, "/tmp/ws/.gaia/worktrees/r1");
  assert.equal(normalizeRoomState({ workDir: "   " }).workDir, undefined);
  assert.equal(normalizeRoomState({ workDir: 42 }).workDir, undefined);
  assert.equal(normalizeRoomState({}).workDir, undefined);
});

// --- the git layer ----------------------------------------------------------

test("ensureRoomWorktree creates a checkout on the room branch under .gaia/worktrees", async () => {
  const root = await scratchRepo();
  try {
    const path = ensureRoomWorktree(root, "nyari-abc123", "gaia/");
    assert.equal(path, workspacePaths.worktreeDir(root, "nyari-abc123"));
    assert.ok(path && existsSync(join(path, ".git")), "worktree has its .git link");
    assert.ok(existsSync(join(path!, "README.md")), "checkout carries the repo content");
    assert.equal(git(path!, "rev-parse", "--abbrev-ref", "HEAD"), roomBranch("gaia/", "nyari-abc123"));
    // Isolation is real: a write in the worktree does not touch the root tree.
    await writeFile(join(path!, "scratch.txt"), "worker output\n");
    assert.equal(existsSync(join(root, "scratch.txt")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureRoomWorktree is idempotent: an existing worktree is reused, uncommitted work intact", async () => {
  const root = await scratchRepo();
  try {
    const first = ensureRoomWorktree(root, "room-1", "gaia/");
    await writeFile(join(first!, "wip.txt"), "uncommitted\n");
    const second = ensureRoomWorktree(root, "room-1", "gaia/");
    assert.equal(second, first);
    assert.ok(existsSync(join(second!, "wip.txt")), "reuse keeps uncommitted work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureRoomWorktree recovers from a stale dir with no .git link (crash mid-add)", async () => {
  const root = await scratchRepo();
  try {
    // Simulate the wedge: a registered worktree whose checkout was destroyed
    // and replaced by a bare dir — `worktree add` fails on this forever unless
    // the stale registration is pruned first.
    const path = ensureRoomWorktree(root, "room-crash", "gaia/")!;
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
    const recovered = ensureRoomWorktree(root, "room-crash", "gaia/");
    assert.equal(recovered, path);
    assert.ok(existsSync(join(recovered!, ".git")), "recovered worktree is healthy");
    assert.equal(git(recovered!, "rev-parse", "--abbrev-ref", "HEAD"), "gaia/room-crash");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureRoomWorktree re-attaches to an existing room branch instead of forking a new one", async () => {
  const root = await scratchRepo();
  try {
    const first = ensureRoomWorktree(root, "room-2", "gaia/")!;
    await writeFile(join(first, "work.txt"), "committed work\n");
    git(first, "add", ".");
    git(first, "commit", "-m", "room work");
    removeRoomWorktree(root, "room-2");
    assert.equal(existsSync(first), false, "checkout removed");
    // Branch survived; a relaunch lands back on it with the committed work.
    const again = ensureRoomWorktree(root, "room-2", "gaia/")!;
    assert.ok(existsSync(join(again, "work.txt")), "re-attached to the room branch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-git workspace: ensureRoomWorktree degrades to undefined, removeRoomWorktree no-ops", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-nogit-"));
  try {
    assert.equal(isGitRepo(root), false);
    assert.equal(ensureRoomWorktree(root, "room-x", "gaia/"), undefined);
    // No stray dirs left behind by the failed attempt.
    assert.equal(existsSync(workspacePaths.worktreesDir(root)), false);
    removeRoomWorktree(root, "room-x"); // must not throw
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeRoomWorktree keeps the branch and prunes the registration", async () => {
  const root = await scratchRepo();
  try {
    ensureRoomWorktree(root, "room-3", "gaia/");
    removeRoomWorktree(root, "room-3");
    assert.equal(existsSync(workspacePaths.worktreeDir(root, "room-3")), false);
    // Branch is the durable half — it must survive the checkout's removal.
    assert.equal(git(root, "rev-parse", "--verify", "refs/heads/gaia/room-3").length > 0, true);
    // Registration is gone: git no longer lists the removed worktree.
    assert.ok(!git(root, "worktree", "list").includes("room-3"));
    // Removing again is a harmless no-op.
    removeRoomWorktree(root, "room-3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
