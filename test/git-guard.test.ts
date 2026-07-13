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
    // reset moved the index/worktree expectations? No — the ref veto aborts
    // the transaction; make sure the checkout still matches main.
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
