import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUNDLE_BINARY_ARTIFACTS,
  BUNDLE_EXEC_MANIFEST_PACKAGE,
  bundleSwapNames,
  resolvePackageManifest,
} from "../src/core/bundle-assets.js";

const repoRoot = join(import.meta.dirname, "..");

/** Independent path (plain node_modules dir walk, no Bun.resolveSync) → the
 * check does not share the resolver's failure mode. */
function installedManifest(): string {
  let dir = repoRoot;
  while (dir !== dirname(dir)) {
    const p = join(dir, "node_modules", BUNDLE_EXEC_MANIFEST_PACKAGE, "package.json");
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error("pi not installed");
}
const installedVersion = (JSON.parse(readFileSync(installedManifest(), "utf8")) as { version: string }).version;

test("resolvePackageManifest finds the installed pi manifest", () => {
  const p = resolvePackageManifest(BUNDLE_EXEC_MANIFEST_PACKAGE, repoRoot);
  assert.equal(p, installedManifest());
  assert.notEqual(installedVersion, "0.0.0");
});

test("package.json is a packaged-only artifact → /rebuild swaps it into the app bundle", () => {
  assert.ok(BUNDLE_BINARY_ARTIFACTS.includes("package.json"));
  assert.ok(bundleSwapNames(false).includes("package.json"));
  assert.ok(!bundleSwapNames(true).includes("package.json"));
});

test("build output ships pi's manifest next to the binary with the installed version", () => {
  const out = join(repoRoot, ".scratch", `test-bundle-${process.pid}`);
  mkdirSync(dirname(out), { recursive: true });
  try {
    const res = spawnSync(process.execPath, [join(repoRoot, "scripts/build-daemon.mjs"), "--out", out], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const shipped = join(out, "package.json");
    assert.ok(existsSync(join(out, "gaia-daemon")));
    assert.ok(existsSync(shipped), "package.json missing from bundle dir");
    const pkg = JSON.parse(readFileSync(shipped, "utf8")) as { name: string; version: string };
    assert.equal(pkg.name, BUNDLE_EXEC_MANIFEST_PACKAGE);
    assert.equal(pkg.version, installedVersion);
    assert.equal(readFileSync(shipped, "utf8"), readFileSync(installedManifest(), "utf8"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 180_000);
