import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { hardenedPath } from "../src/core/env.js";

// hardenedPath repairs a bare launcher PATH (GUI/launchd spawn) by appending
// well-known bin dirs — but only ones that exist, only once, and never ahead
// of what the launcher provided.
test("hardenedPath appends existing candidate dirs missing from PATH", () => {
  const real = mkdtempSync(join(tmpdir(), "gaia-env-"));
  try {
    const out = hardenedPath("/usr/bin", [real]);
    assert.equal(out, `/usr/bin${delimiter}${real}`);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test("hardenedPath skips candidates that do not exist on disk", () => {
  const ghost = join(tmpdir(), "gaia-env-does-not-exist-xyz");
  assert.equal(hardenedPath("/usr/bin", [ghost]), "/usr/bin");
});

test("hardenedPath never duplicates dirs already on PATH", () => {
  const real = mkdtempSync(join(tmpdir(), "gaia-env-"));
  try {
    const current = `${real}${delimiter}/usr/bin`;
    assert.equal(hardenedPath(current, [real]), current);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test("hardenedPath builds a PATH from nothing (bare launchd env)", () => {
  const real = mkdtempSync(join(tmpdir(), "gaia-env-"));
  try {
    assert.equal(hardenedPath(undefined, [real]), real);
    assert.equal(hardenedPath("", [real]), real);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});
