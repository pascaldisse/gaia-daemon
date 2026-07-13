#!/usr/bin/env bun
// Install the gaia git-guards into a repository's shared hooks directory.
//
// Idempotent. Installs scripts/git-hooks/* into the repo's COMMON hooks dir
// (`git rev-parse --git-common-dir`/hooks), which every linked worktree shares —
// so one install protects the root checkout AND every room worktree at once.
//
// Usage:
//   bun scripts/install-git-guards.mjs [repo-path]
// repo-path defaults to this script's repository root. Safe to run on every
// daemon boot and every worktree creation; it only rewrites a hook when its
// content actually changed.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const hookSrcDir = join(scriptDir, "git-hooks");

const repoArg = process.argv[2] ? resolve(process.argv[2]) : resolve(scriptDir, "..");

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

// Resolve the shared hooks directory. Respect an explicit core.hooksPath if set,
// otherwise use the common dir's hooks/ (shared by all worktrees).
let hooksDir;
const configuredHooksPath = spawnSync("git", ["-C", repoArg, "config", "--get", "core.hooksPath"], {
  encoding: "utf8",
});
if (configuredHooksPath.status === 0 && configuredHooksPath.stdout.trim()) {
  hooksDir = resolve(repoArg, configuredHooksPath.stdout.trim());
} else {
  const commonDir = git(["-C", repoArg, "rev-parse", "--git-common-dir"], repoArg);
  hooksDir = resolve(repoArg, commonDir, "hooks");
}

mkdirSync(hooksDir, { recursive: true });

let installed = 0;
let unchanged = 0;
for (const name of readdirSync(hookSrcDir)) {
  const src = join(hookSrcDir, name);
  const dst = join(hooksDir, name);
  const desired = readFileSync(src, "utf8");
  const current = existsSync(dst) ? readFileSync(dst, "utf8") : null;
  if (current === desired) {
    chmodSync(dst, 0o755); // keep it executable even if unchanged
    unchanged++;
    continue;
  }
  writeFileSync(dst, desired);
  chmodSync(dst, 0o755);
  installed++;
  console.log(`installed hook: ${name} -> ${dst}`);
}

console.log(`gaia git-guards: ${installed} installed, ${unchanged} up-to-date in ${hooksDir}`);
