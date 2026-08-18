#!/usr/bin/env bun
// Compiles the gaia daemon into a standalone binary via `bun build --compile`,
// then snapshots the runtime assets (web/, setups/) alongside it.
//
// Usage: bun scripts/build-daemon.mjs [--out <dir>] [--target <bun-target>]

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
// Single source of truth shared with the /rebuild atomic swap (src/server/http.ts).
import { BUNDLE_ASSET_DIRS, BUNDLE_ASSET_EXCLUDES } from "../src/core/bundle-assets.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

function option(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const argv = process.argv.slice(2);
const outDir = option(argv, "--out", join(repoRoot, "dist"));
// Native by default: /rebuild must replace its executable with one for its own
// host. Release builds select a deploy target explicitly (e.g. bun-linux-x64).
const target = option(argv, "--target", `bun-${process.platform}-${process.arch}`);

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

function compileBinary(label, entrypoint, outputName) {
  const binaryTmp = join(outDir, `${outputName}.new`);
  const binaryFinal = join(outDir, outputName);
  // process.execPath, never a bare "bun" — this script is itself run BY bun,
  // so execPath is always correct and needs no PATH lookup. A GUI-launched
  // app (Finder/Dock, no login-shell PATH) does not have ~/.bun/bin on PATH,
  // so a bare "bun" spawn here fails silently (ENOENT) the moment /rebuild
  // runs from the compiled app instead of a terminal — observed live
  // 2026-07-11: /rebuild died instantly with no bundle/compile output at all.
  timeStep(`${label}-compile`, () => {
    const res = spawnSync(
      process.execPath,
      ["build", "--compile", "--target", target, entrypoint, "--outfile", binaryTmp],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
    );
    if (res.status !== 0) {
      console.error(res.stderr || res.stdout || `bun build exited ${res.status}`);
      process.exit(1);
    }
    if (res.stdout) process.stdout.write(res.stdout);
  });

  timeStep(`${label}-install`, () => {
    chmodSync(binaryTmp, 0o755);
    renameSync(binaryTmp, binaryFinal);
  });
}

compileBinary("daemon", join(repoRoot, "src/cli.ts"), "gaia-daemon");
compileBinary("telegram-bridge", join(repoRoot, "scripts/telegram-bridge.mjs"), "gaia-telegram-bridge");

for (const name of BUNDLE_ASSET_DIRS) {
  timeStep(`snapshot-${name}`, () => {
    const src = join(repoRoot, name);
    const dstTmp = join(outDir, `${name}.new`);
    const dstFinal = join(outDir, name);
    rmSync(dstTmp, { recursive: true, force: true });
    cpSync(src, dstTmp, { recursive: true });
    for (const relative of BUNDLE_ASSET_EXCLUDES[name] ?? []) {
      rmSync(join(dstTmp, relative), { recursive: true, force: true });
    }
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
        target,
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
});

const totalMs = performance.now() - totalStart;
const binarySize = statSync(join(outDir, "gaia-daemon")).size;
const telegramBridgeSize = statSync(join(outDir, "gaia-telegram-bridge")).size;

console.log("---");
for (const [label, ms] of timings) {
  console.log(`${label}: ${ms.toFixed(1)}ms`);
}
console.log(`total: ${totalMs.toFixed(1)}ms`);
console.log(`target: ${target}`);
console.log(`binary: ${join(outDir, "gaia-daemon")} (${binarySize} bytes)`);
console.log(`telegram-bridge: ${telegramBridgeSize} bytes`);
