import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_TRANSACTION_HOOK, installGitGuard } from "../src/domain/git-guard.js";

// Every spawn gets an env WITHOUT GAIA_GIT_GUARD (except the one sanctioned
// off-switch test) so an ambient escape hatch can never fake a pass.
function guardEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!extra || !("GAIA_GIT_GUARD" in extra)) delete env.GAIA_GIT_GUARD;
  return env;
}

function run(cwd: string, args: string[], extraEnv?: Record<string, string>) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: guardEnv(extraEnv) });
}

function git(cwd: string, ...args: string[]): string {
  const r = run(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

function makeRepo(): { dir: string; shaA: string; shaB: string } {
  const dir = mkdtempSync(join(tmpdir(), "gaia-guard-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "guard@test");
  git(dir, "config", "user.name", "guard");
  const shaA = commit(dir, "a.txt");
  const shaB = commit(dir, "b.txt");
  installGitGuard(dir);
  return { dir, shaA, shaB };
}

const mainTip = (dir: string) => git(dir, "rev-parse", "refs/heads/main");

test("embedded hook is byte-identical to scripts/git-hooks/reference-transaction (drift pin)", () => {
  const disk = readFileSync(new URL("../scripts/git-hooks/reference-transaction", import.meta.url), "utf8");
  assert.strictEqual(REFERENCE_TRANSACTION_HOOK, disk);
});

test("git-guard blocks every rewind vector, allows fast-forward", () => {
  const { dir, shaA, shaB } = makeRepo();
  try {
    // (a) reset --hard to an ancestor is rejected, main unchanged.
    let r = run(dir, ["reset", "--hard", shaA]);
    assert.notEqual(r.status, 0, "reset --hard should be vetoed");
    assert.equal(mainTip(dir), shaB);
    // HONESTY (per red-team): a vetoed `reset --hard <older>` still lets git
    // move the index/worktree toward <older> and discard dirty tracked content
    // BEFORE it proposes the ref update the hook then refuses. The guard
    // protects the landed COMMITS on the ref, NOT uncommitted work or git's
    // pre-ref side effects — so we assert only that main's tip held, never that
    // the working tree still matches main.
    git(dir, "status");

    // (b) update-ref with no expected-old (the spoofed-zero case) is rejected.
    r = run(dir, ["update-ref", "refs/heads/main", shaA]);
    assert.notEqual(r.status, 0, "update-ref should be vetoed");
    assert.equal(mainTip(dir), shaB);

    // (c) branch -f from a side branch is rejected.
    git(dir, "checkout", "-b", "side");
    r = run(dir, ["branch", "-f", "main", shaA]);
    assert.notEqual(r.status, 0, "branch -f should be vetoed");
    assert.equal(mainTip(dir), shaB);

    // (d) branch -D of the protected branch is rejected.
    r = run(dir, ["branch", "-D", "main"]);
    assert.notEqual(r.status, 0, "branch -D should be vetoed");
    assert.equal(mainTip(dir), shaB);

    // (e) a normal fast-forward commit on main is allowed.
    git(dir, "checkout", "main");
    const shaC = commit(dir, "c.txt");
    assert.equal(mainTip(dir), shaC);

    // (f) a real room-branch landing via merge --ff-only is allowed.
    git(dir, "checkout", "-b", "room");
    const shaD = commit(dir, "d.txt");
    git(dir, "checkout", "main");
    r = run(dir, ["merge", "--ff-only", "room"]);
    assert.equal(r.status, 0, `ff-only landing should pass: ${r.stderr}`);
    assert.equal(mainTip(dir), shaD);

    // (h) a NON-protected branch rewinds freely.
    git(dir, "checkout", "-b", "free");
    commit(dir, "e.txt");
    r = run(dir, ["reset", "--hard", shaD]);
    assert.equal(r.status, 0, `non-protected rewind should pass: ${r.stderr}`);

    // (g) GAIA_GIT_GUARD=off allows a deliberate rewind of main.
    // The ONLY sanctioned use of the off switch — it exists for human recovery.
    git(dir, "checkout", "main");
    r = run(dir, ["reset", "--hard", shaA], { GAIA_GIT_GUARD: "off" });
    assert.equal(r.status, 0, `off-switch rewind should pass: ${r.stderr}`);
    assert.equal(mainTip(dir), shaA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-guard tolerates loose->packed migration (pack-refs / gc succeed) but still blocks genuine deletion", () => {
  const { dir, shaB } = makeRepo();
  try {
    // pack-refs migrates main loose->packed: the loose removal is reported to
    // the hook as a deletion (tip -> zero) though the tip survives in
    // packed-refs. A naive delete-veto broke routine maintenance (gc exit 128);
    // this must now pass.
    let r = run(dir, ["pack-refs", "--all"]);
    assert.equal(r.status, 0, `pack-refs should pass: ${r.stderr}`);
    assert.equal(mainTip(dir), shaB, "main survives pack-refs");
    // gc runs pack-refs internally — must also succeed.
    r = run(dir, ["gc"]);
    assert.equal(r.status, 0, `gc should pass: ${r.stderr}`);
    assert.equal(mainTip(dir), shaB);
    // Packed-only genuine deletion must STILL be refused — the migration
    // exception must not become a hole. `update-ref -d` is the sharp case: git
    // does NOT natively block it even for a checked-out branch, so the hook is
    // the only thing standing between it and an orphaned main.
    git(dir, "checkout", "-b", "aside");
    r = run(dir, ["update-ref", "-d", "refs/heads/main"]);
    assert.notEqual(r.status, 0, "packed-only delete of protected branch must stay blocked");
    assert.equal(mainTip(dir), shaB);

    // Stale-packed deletion: advance a NEW loose tip so packed OID (shaB) is
    // behind the current tip. The migration signature requires packed OID ==
    // current tip, so this deletion must also be refused.
    git(dir, "checkout", "main");
    const shaC = commit(dir, "c.txt"); // loose main -> shaC; packed still shaB
    git(dir, "checkout", "aside");
    r = run(dir, ["update-ref", "-d", "refs/heads/main"]);
    assert.notEqual(r.status, 0, "stale-packed delete must stay blocked");
    assert.equal(mainTip(dir), shaC);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-guard falls back to the default ref when GAIA_PROTECTED_REFS is empty/blank (no silent bypass)", () => {
  const { dir, shaA, shaB } = makeRepo();
  try {
    // "" is not null/undefined, so a naive `?? default` would leave the set
    // empty and disable the guard entirely. Empty AND whitespace must both fall
    // back to refs/heads/main and keep blocking.
    let r = run(dir, ["reset", "--hard", shaA], { GAIA_PROTECTED_REFS: "" });
    assert.notEqual(r.status, 0, "empty env must not disable the guard");
    assert.equal(mainTip(dir), shaB);
    r = run(dir, ["reset", "--hard", shaA], { GAIA_PROTECTED_REFS: "   " });
    assert.notEqual(r.status, 0, "whitespace env must not disable the guard");
    assert.equal(mainTip(dir), shaB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installGitGuard is idempotent and never throws on a non-repo", () => {
  const { dir } = makeRepo();
  try {
    const hookPath = join(dir, ".git", "hooks", "reference-transaction");
    assert.strictEqual(readFileSync(hookPath, "utf8"), REFERENCE_TRANSACTION_HOOK);
    installGitGuard(dir); // second run: unchanged content, still fine
    assert.strictEqual(readFileSync(hookPath, "utf8"), REFERENCE_TRANSACTION_HOOK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const plain = mkdtempSync(join(tmpdir(), "gaia-guard-norepo-"));
  try {
    installGitGuard(plain); // must warn, not throw
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
