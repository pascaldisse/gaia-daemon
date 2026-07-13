// Self-installing gaia git-guard (see scripts/git-hooks/reference-transaction).
//
// WHY EMBEDDED: the compiled bun binary does NOT snapshot scripts/, so the
// runtime installer cannot read the hook from disk on a production install or
// a fresh clone whose hooks dir was never populated. The hook content lives
// here as a constant; test/git-guard.test.ts pins it byte-identical to
// scripts/git-hooks/reference-transaction so the two copies can never drift.
//
// Best-effort philosophy (mirrors worktree.ts): installGitGuard never throws —
// any failure degrades to a console.warn, never wedges room init or boot.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The reference-transaction hook, byte-identical to scripts/git-hooks/reference-transaction. */
export const REFERENCE_TRANSACTION_HOOK = `#!/usr/bin/env bun
// gaia git-guard — reference-transaction hook.
//
// WHY THIS EXISTS (read AGENTS.md "ROOT CHECKOUT IS MERGE-ONLY"):
// The shared root checkout's \`main\` is a merge highway. Confused agents (and the
// occasional human) have destroyed already-landed work dozens of times by running
// raw git surgery — \`git reset --hard <older>\`, \`git branch -f main <older>\`,
// \`git checkout -B main <older>\`, \`git update-ref\`, force-push — that rewinds
// \`main\` backward, orphaning commits other rooms already fast-forwarded in.
//
// A doc rule cannot stop a command that has already been typed. This hook can.
// It runs INSIDE git's reference-transaction machinery, so it fires for EVERY
// command that moves a ref — no matter which porcelain triggered it — and vetoes
// the transaction before it commits.
//
// THE RULE: a protected branch (default: refs/heads/main) may only
//   - be created (old == zero), or
//   - fast-forward, i.e. move to a commit that has its current tip as an ancestor.
// It may NOT be rewound, moved sideways to a divergent commit, or deleted.
// Fast-forward landings (\`git merge --ff-only <room-branch>\`) still pass cleanly.
//
// ESCAPE HATCH: set GAIA_GIT_GUARD=off for a single deliberate command. This is
// for Pascal / genuine recovery only; agents told "never rewind main" will never
// set it, which is exactly the accidental class of failure we are killing.
//
// Protected refs are configurable via the env var GAIA_PROTECTED_REFS
// (comma-separated full ref names); default is "refs/heads/main".

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const state = process.argv[2];
// Only the "prepared" state can veto: a non-zero exit here aborts the whole
// transaction before any ref is written. "committed"/"aborted" are informational.
if (state !== "prepared") process.exit(0);

if (process.env.GAIA_GIT_GUARD === "off") process.exit(0);

const zeroRe = /^0+$/; // all-zeros == git's null-oid sentinel

// Parse the protected-ref allow-list defensively. \`??\` alone would NOT fall
// back on an empty/whitespace string (GAIA_PROTECTED_REFS="" is not
// null/undefined), which would silently disable the guard for every ref — an
// unacceptable quiet bypass via an ordinary-looking env var. Treat empty/blank
// as unset, and never let the resulting set end up empty.
const rawProtected = (process.env.GAIA_PROTECTED_REFS ?? "").trim();
const protectedRefs = new Set(
  (rawProtected || "refs/heads/main")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (protectedRefs.size === 0) protectedRefs.add("refs/heads/main");

const input = await new Response(process.stdin).text();

for (const line of input.split("\\n")) {
  if (!line) continue;
  // "<old-oid> SP <new-oid> SP <ref-name>"
  const sp1 = line.indexOf(" ");
  const sp2 = line.indexOf(" ", sp1 + 1);
  if (sp1 < 0 || sp2 < 0) continue;
  const newOid = line.slice(sp1 + 1, sp2);
  const ref = line.slice(sp2 + 1);

  if (!protectedRefs.has(ref)) continue;

  // Do NOT trust the reported old-oid: git reports it as zero for deletions and
  // for any updater (e.g. \`git update-ref\` without an expected value) that
  // omits it — which would let a rewind masquerade as a "creation". Instead read
  // the ref's authoritative current tip. In the "prepared" state the ref still
  // holds its pre-transaction value, so this is the true tip we must protect.
  const cur = spawnSync("git", ["rev-parse", "--verify", "--quiet", \`\${ref}^{commit}\`], { encoding: "utf8" });
  const currentTip = cur.status === 0 ? cur.stdout.trim() : null;

  // Deletion (new-oid == zero) of a protected branch is forbidden — with ONE
  // narrow exception: git's internal loose->packed migration (\`git pack-refs\` /
  // \`gc\`). pack-refs writes the ref into packed-refs FIRST, then removes the
  // loose file, and that loose removal is reported here as a deletion
  // (tip -> zero) even though the tip is preserved. Naively rejecting it broke
  // routine maintenance (\`git gc\` exited 128) on the very checkout we protect.
  // We allow the deletion ONLY when it carries the exact migration signature —
  // ALL THREE must hold, else the tip would truly be orphaned:
  //   1. the loose ref file still exists (it is what pack-refs is removing),
  //   2. packed-refs already records this ref, AND
  //   3. that packed OID equals the authoritative current tip (not a stale
  //      packed value shadowed by a newer loose tip).
  // This still refuses packed-only deletion (\`update-ref -d\` after gc — which
  // git does NOT natively block even for a checked-out branch), loose-only
  // deletion, and stale-packed deletion, while letting gc/pack-refs run.
  if (zeroRe.test(newOid)) {
    if (currentTip) {
      const packedOid = packedRefOid(ref);
      const isMigration = looseRefFileExists(ref) && packedOid !== null && packedOid === currentTip;
      if (!isMigration) {
        reject(ref, currentTip, newOid, "deletion of a protected branch is forbidden");
      }
    }
    continue; // storage migration, or nothing there to protect
  }

  // Creation: the protected ref does not exist yet. Allowed.
  if (!currentTip) continue;

  // Update of an existing protected ref. If we cannot see the target object we
  // cannot judge ancestry; fail SAFE by refusing.
  const haveNew = spawnSync("git", ["cat-file", "-e", \`\${newOid}^{commit}\`]).status === 0;
  if (!haveNew) {
    reject(ref, currentTip, newOid, "target commit is not present/verifiable");
  }

  // Fast-forward only: current tip must be an ancestor of the target.
  const isFastForward =
    spawnSync("git", ["merge-base", "--is-ancestor", currentTip, newOid]).status === 0;
  if (!isFastForward) {
    reject(ref, currentTip, newOid, "non-fast-forward update (rewind / divergent move) is forbidden");
  }
}

process.exit(0);

/**
 * The OID packed-refs currently records for \`ref\`, or null if none. During a
 * loose->packed migration pack-refs writes this BEFORE removing the loose ref,
 * so it equals the current tip; for a genuine deletion it is absent or stale.
 * @param {string} ref
 * @returns {string | null}
 */
function packedRefOid(ref) {
  const p = spawnSync("git", ["rev-parse", "--git-path", "packed-refs"], { encoding: "utf8" });
  if (p.status !== 0) return null;
  try {
    const txt = readFileSync(p.stdout.trim(), "utf8");
    for (const line of txt.split("\\n")) {
      // "<oid> <ref>" — skip "^<peeled>" tag lines, comments, and blanks.
      const sp = line.indexOf(" ");
      if (sp > 0 && line.slice(sp + 1) === ref) return line.slice(0, sp);
    }
  } catch {
    // no packed-refs file / unreadable — treat as "not packed".
  }
  return null;
}

/**
 * Does a LOOSE ref file exist for \`ref\`? True mid-migration (the file that
 * pack-refs is about to remove); false once the ref is packed-only.
 * @param {string} ref
 * @returns {boolean}
 */
function looseRefFileExists(ref) {
  const p = spawnSync("git", ["rev-parse", "--git-path", ref], { encoding: "utf8" });
  if (p.status !== 0) return false;
  return existsSync(p.stdout.trim());
}

/**
 * @param {string} ref @param {string} oldOid @param {string} newOid @param {string} why
 * @returns {never}
 */
function reject(ref, oldOid, newOid, why) {
  const R = "\\x1b[31m";
  const B = "\\x1b[1m";
  const X = "\\x1b[0m";
  process.stderr.write(
    \`\\n\${R}\${B}✗ gaia git-guard: refused to move \${ref}\${X}\\n\` +
      \`  \${oldOid.slice(0, 10)} → \${newOid.slice(0, 10)}\\n\` +
      \`  reason: \${why}.\\n\\n\` +
      \`  \${ref} is protected and may only FAST-FORWARD. This is what stops\\n\` +
      \`  already-landed work from being erased (AGENTS.md: the root checkout is\\n\` +
      \`  merge-only; git reset --hard / branch -f / checkout -B on it are banned).\\n\\n\` +
      \`  Do your git surgery in your room worktree branch, then land with\\n\` +
      \`    git -C <root> merge --ff-only <your-branch>\\n\` +
      \`  If you are stuck mid-rebase, get out cleanly with:  git rebase --abort\\n\` +
      \`  If this is a deliberate, human-authorized recovery, re-run the one\\n\` +
      \`  command with:  GAIA_GIT_GUARD=off git ...\\n\\n\`,
  );
  process.exit(1);
}
`;

/** Run git in \`cwd\`, returning stdout or throwing on non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Install the git-guard reference-transaction hook into the repository that
 * contains \`rootDir\`, idempotently. The hook goes into the SHARED common
 * hooks directory (git rev-parse --git-common-dir + /hooks, honoring an
 * explicit core.hooksPath) so one install protects the root checkout AND
 * every linked room worktree at once. Only rewrites when content differs;
 * always re-asserts the executable bit. Never throws: not-a-repo, missing
 * git, or an unwritable hooks dir degrade to a warn — installation is
 * self-healing on every room init and daemon boot, so a transient failure
 * here is never load-bearing.
 */
export function installGitGuard(rootDir: string): void {
  try {
    let hooksDir: string;
    let configured = "";
    try {
      configured = git(rootDir, "config", "--get", "core.hooksPath");
    } catch {
      // Unset core.hooksPath exits 1 — fall through to the common dir.
    }
    if (configured) {
      hooksDir = resolve(rootDir, configured);
    } else {
      hooksDir = resolve(rootDir, git(rootDir, "rev-parse", "--git-common-dir"), "hooks");
    }
    mkdirSync(hooksDir, { recursive: true });
    const dst = join(hooksDir, "reference-transaction");
    const current = existsSync(dst) ? readFileSync(dst, "utf8") : null;
    if (current !== REFERENCE_TRANSACTION_HOOK) {
      writeFileSync(dst, REFERENCE_TRANSACTION_HOOK);
    }
    chmodSync(dst, 0o755);
  } catch (error) {
    console.warn(`git-guard: could not install into ${rootDir} (${String(error)})`);
  }
}
