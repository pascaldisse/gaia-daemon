// Room git worktrees (collab.isolation "worktree"): only TOP-LEVEL rooms
// (no parentRoomId) own a checkout, under .gaia/worktrees/<roomId> on branch
// <prefix><roomId> — created on first resolution (room-service init). The
// object store stays shared; only the checkout + index are per-owning-room.
// Summon rooms never get one of their own: resolveRoomWorkDir walks a summon
// room's parent chain and hands it the nearest ancestor's checkout, creating
// the top-level ancestor's worktree along the way if it doesn't exist yet —
// so a worker always operates on the same branch/files as the room that
// summoned it, all the way up to the room a human opened.
//
// Design invariants:
// - Best-effort, never load-bearing: every failure degrades to "run at the
//   workspace root" (today's shared behavior) instead of blocking room init.
// - Crash-safe: a stale worktree registration (killed mid-add, checkout
//   trashed by hand) is pruned before we look at it, never a permanent wedge.
// - Removal keeps the BRANCH. The worktree checkout is disposable; the
//   room's committed work is not. Integration back to main is a human/agent
//   decision.
//
// Sync on purpose: called once at room-service init / room trash, both
// already on synchronous state-mutation paths; git worktree add on a local
// repo is fast.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../core/paths.js";
import { readJson } from "../core/store.js";
import type { CollabConfig, RoomState } from "../core/types.js";
import { normalizeRoomState } from "./rooms.js";

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
function roomBranch(branchPrefix: string, roomId: string): string {
  return `${branchPrefix}${roomId}`;
}

function branchExists(rootDir: string, branch: string): boolean {
  try {
    git(rootDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a worktree exists for this room and return its absolute path, or
 * undefined when isolation can't apply (not a git repo, git missing, add
 * failed). Idempotent: an existing registered worktree is reused as-is — a
 * relaunched/resumed room lands back in its own checkout with its uncommitted
 * work intact. Never throws — any git failure is swallowed and reported as
 * undefined so the caller falls back to the workspace root.
 */
export function ensureRoomWorktree(rootDir: string, roomId: string, branchPrefix: string): string | undefined {
  if (!isGitRepo(rootDir)) return undefined;
  const path = workspacePaths.worktreeDir(rootDir, roomId);
  try {
    // Prune first: clears stale registrations for checkouts that vanished
    // (crash mid-add, manual deletion of the link) so a re-add below can't
    // get wedged forever on a registration git still remembers.
    git(rootDir, "worktree", "prune");
    // Healthy existing worktree: the .git link file is what makes a worktree
    // a worktree. Present after prune → it's still registered → reuse it.
    if (existsSync(join(path, ".git"))) return path;
    const branch = roomBranch(branchPrefix, roomId);
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
 * The working directory a room's agents run in, under collab.isolation
 * "worktree". Top-level rooms (no parentRoomId) OWN a worktree — created here
 * on first resolution. Summon rooms NEVER own one: they inherit the nearest
 * ancestor's, walking the parent chain to the top-level room. Returns
 * undefined when isolation is off, the workspace is not a git repo, or
 * creation failed — callers then run at the workspace root. Ancestors are
 * read-only here (each room stamps its own state when opened); the caller
 * stamps the returned value on its own room.
 */
export async function resolveRoomWorkDir(
  rootDir: string,
  collab: CollabConfig | undefined,
  state: Pick<RoomState, "parentRoomId" | "workDir">,
  roomId: string,
): Promise<string | undefined> {
  if (collab?.isolation !== "worktree") return undefined;
  if (state.workDir && existsSync(state.workDir)) return state.workDir;
  let ownerId = roomId;
  let current: Pick<RoomState, "parentRoomId" | "workDir"> = state;
  const seen = new Set<string>([roomId]);
  while (current.parentRoomId) {
    const parentId = current.parentRoomId;
    if (seen.has(parentId)) return undefined; // corrupt cycle — degrade to root
    seen.add(parentId);
    const parentState = normalizeRoomState(await readJson(workspacePaths.roomState(rootDir, parentId)));
    if (parentState.workDir && existsSync(parentState.workDir)) return parentState.workDir;
    ownerId = parentId;
    current = parentState;
  }
  return ensureRoomWorktree(rootDir, ownerId, collab.branchPrefix);
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
