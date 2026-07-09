// Room git worktrees (collab.isolation "worktree"): each summon room gets its
// own checkout under .gaia/worktrees/<roomId> on branch <prefix><roomId>, so
// concurrent agents in one repo stop colliding on a single working tree/index.
// The object store stays shared; only the checkout + index are per-room.
//
// Design invariants:
// - Best-effort, never load-bearing: every failure degrades to "run at the
//   workspace root" (today's shared behavior) instead of blocking a summon.
// - Crash-safe: a stale worktree dir whose .git link git no longer knows about
//   (killed mid-add, trashed by hand) is pruned and re-added, never a permanent
//   wedge.
// - Removal keeps the BRANCH. The worktree checkout is disposable; the room's
//   committed work is not. Integration back to main is a human/agent decision.
//
// Sync on purpose: called once at summon launch / room trash, both already on
// synchronous state-mutation paths; git worktree add on a local repo is fast.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../core/paths.js";

/** Run git in `cwd`, returning stdout or throwing on non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Is rootDir inside a git working tree? (Not bare, not a plain folder.) */
export function isGitRepo(rootDir: string): boolean {
  try {
    return git(rootDir, "rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false;
  }
}

/** The branch a room's worktree lives on: `<prefix><roomId>`. */
export function roomBranch(branchPrefix: string, roomId: string): string {
  return `${branchPrefix}${roomId}`;
}

/**
 * Ensure a worktree exists for this room and return its absolute path, or
 * undefined when isolation can't apply (not a git repo, git missing, add
 * failed). Idempotent: an existing healthy worktree is reused as-is — a
 * relaunched/resumed room lands back in its own checkout with its uncommitted
 * work intact.
 */
export function ensureRoomWorktree(rootDir: string, roomId: string, branchPrefix: string): string | undefined {
  if (!isGitRepo(rootDir)) return undefined;
  const path = workspacePaths.worktreeDir(rootDir, roomId);
  // Healthy existing worktree: the .git link file is what makes a worktree a
  // worktree. Present → reuse.
  if (existsSync(join(path, ".git"))) return path;
  const branch = roomBranch(branchPrefix, roomId);
  try {
    // Recovery before add: a leftover dir without .git (crash mid-add, manual
    // deletion of the link) makes `worktree add` fail forever, and git may
    // still hold a registration for a checkout that vanished. Prune clears
    // stale registrations; it never touches live worktrees.
    git(rootDir, "worktree", "prune");
    if (branchExists(rootDir, branch)) {
      // The room worked here before (worktree removed, branch kept — or a
      // previous daemon life). Re-attach to its branch, don't fork a new one.
      git(rootDir, "worktree", "add", path, branch);
    } else {
      git(rootDir, "worktree", "add", "-b", branch, path, "HEAD");
    }
    return path;
  } catch (error) {
    console.warn(`worktree: could not isolate room ${roomId} (${String(error)}); running at workspace root`);
    return undefined;
  }
}

/**
 * Remove a room's worktree checkout (room deletion). Keeps the branch —
 * committed work stays reachable; only the disposable checkout goes. Best
 * effort: failures are logged, never thrown (room trash must not wedge on a
 * half-broken worktree).
 */
export function removeRoomWorktree(rootDir: string, roomId: string): void {
  const path = workspacePaths.worktreeDir(rootDir, roomId);
  if (!existsSync(path) || !isGitRepo(rootDir)) return;
  try {
    // --force: uncommitted scratch in a deleted room's checkout is expected
    // and must not block the removal.
    git(rootDir, "worktree", "remove", "--force", path);
  } catch (error) {
    console.warn(`worktree: could not remove ${path} (${String(error)})`);
  }
  try {
    git(rootDir, "worktree", "prune");
  } catch {
    // prune is housekeeping; its failure is not worth a second warning.
  }
}

function branchExists(rootDir: string, branch: string): boolean {
  try {
    git(rootDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}
