import { test } from "bun:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, globalPaths } from "../src/core/paths.js";

test("expandHome expands only home shorthand", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/folder"), join(homedir(), "folder"));
  assert.equal(expandHome("relative/folder"), "relative/folder");
});

test("global path helpers follow GAIA_HOME", () => {
  const prior = process.env.GAIA_HOME;
  process.env.GAIA_HOME = "/gaia-test-home";
  try {
    assert.equal(globalPaths.commandPluginsDir(), "/gaia-test-home/plugins");
    assert.equal(globalPaths.ambientWatchdogDir(), "/gaia-test-home/ambient-watchdog");
    assert.equal(globalPaths.cacheBinDir(), "/gaia-test-home/cache/bin");
  } finally {
    if (prior === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = prior;
  }
});
