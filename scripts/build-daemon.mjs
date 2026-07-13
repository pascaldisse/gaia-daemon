#!/usr/bin/env bun
// Compiles the gaia daemon into a standalone binary via `bun build --compile`,
// then snapshots the runtime assets (web/, setups/) alongside it.
//
// Usage: bun scripts/build-daemon.mjs [--out <dir>]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
  cpSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

function parseOutDir(argv) {
  const i = argv.indexOf("--out");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return join(repoRoot, "dist");
}

const outDir = parseOutDir(process.argv.slice(2));

const timings = [];
function timeStep(label, fn) {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  timings.push([label, ms]);
  console.log(`[${label}] ${ms.toFixed(1)}ms`);
  return result;
}

const totalStart = performance.now();

timeStep("mkdir-out", () => {
  mkdirSync(outDir, { recursive: true });
});

const binaryTmp = join(outDir, "gaia-daemon.new");
const binaryFinal = join(outDir, "gaia-daemon");

timeStep("bun-build-compile", () => {
  // process.execPath, never a bare "bun" — this script is itself run BY bun,
  // so execPath is always correct and needs no PATH lookup. A GUI-launched
  // app (Finder/Dock, no login-shell PATH) does not have ~/.bun/bin on PATH,
  // so a bare "bun" spawn here fails silently (ENOENT) the moment /rebuild
  // runs from the compiled app instead of a terminal — observed live
  // 2026-07-11: /rebuild died instantly with no bundle/compile output at all.
  const res = spawnSync(
    process.execPath,
    ["build", "--compile", join(repoRoot, "src/cli.ts"), "--outfile", binaryTmp],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout || `bun build exited ${res.status}`);
    process.exit(1);
  }
  if (res.stdout) process.stdout.write(res.stdout);
});

timeStep("install-binary", () => {
  chmodSync(binaryTmp, 0o755);
  renameSync(binaryTmp, binaryFinal);
});

for (const name of ["web", "setups"]) {
  timeStep(`snapshot-${name}`, () => {
    const src = join(repoRoot, name);
    const dstTmp = join(outDir, `${name}.new`);
    const dstFinal = join(outDir, name);
    rmSync(dstTmp, { recursive: true, force: true });
    cpSync(src, dstTmp, { recursive: true });
    rmSync(dstFinal, { recursive: true, force: true });
    renameSync(dstTmp, dstFinal);
  });
}

timeStep("write-source-json", () => {
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);

  writeFileSync(
    join(outDir, "gaia-source.json"),
    JSON.stringify(
      {
        root: repoRoot,
        bun: process.execPath,
        commit,
        dirty: status !== null && status !== "",
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
});

const totalMs = performance.now() - totalStart;
const binarySize = statSync(binaryFinal).size;

console.log("---");
for (const [label, ms] of timings) {
  console.log(`${label}: ${ms.toFixed(1)}ms`);
}
console.log(`total: ${totalMs.toFixed(1)}ms`);
console.log(`binary: ${binaryFinal} (${binarySize} bytes)`);
