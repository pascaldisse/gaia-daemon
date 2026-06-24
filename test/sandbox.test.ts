import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSandbox,
  resolveSandboxLaunch,
  resolveSandboxPolicy,
  sandboxBackendIds,
} from "../src/runtime/sandbox/index.ts";

const ARGV = ["/usr/bin/node", "cli.js", "__run-agent"];

test("resolveSandboxPolicy: normal agents default off, summons default on", () => {
  assert.equal(resolveSandboxPolicy(undefined, undefined, false).enabled, false);
  assert.equal(resolveSandboxPolicy(undefined, undefined, true).enabled, true);
});

test("resolveSandboxPolicy: agent override beats workspace default; backend defaults to none", () => {
  const policy = resolveSandboxPolicy({ enabled: false, backend: "apple-container" }, { enabled: true }, false);
  assert.equal(policy.enabled, true);
  assert.equal(policy.backend, "apple-container");
  assert.equal(resolveSandboxPolicy(undefined, undefined, true).backend, "none");
});

test("resolveSandboxLaunch: disabled or none backend is the identity launch", async () => {
  const off = await resolveSandboxLaunch({ enabled: false }, ARGV, "/work");
  assert.deepEqual(off, { command: "/usr/bin/node", args: ["cli.js", "__run-agent"] });
  const none = await resolveSandboxLaunch({ enabled: true, backend: "none" }, ARGV, "/work");
  assert.deepEqual(none, { command: "/usr/bin/node", args: ["cli.js", "__run-agent"] });
});

test("resolveSandboxLaunch: an available backend rewrites the launch", async () => {
  registerSandbox({
    id: "test-wrap",
    available: () => true,
    wrap: (spec) => ({ command: "isolate", args: ["--cwd", spec.cwd, "--", ...spec.argv] }),
  });
  const launch = await resolveSandboxLaunch({ enabled: true, backend: "test-wrap" }, ARGV, "/work");
  assert.equal(launch.command, "isolate");
  assert.deepEqual(launch.args, ["--cwd", "/work", "--", ...ARGV]);
});

test("resolveSandboxLaunch: fails closed when an enabled backend is unavailable", async () => {
  registerSandbox({ id: "test-down", available: () => false, wrap: (spec) => ({ command: spec.argv[0], args: [] }) });
  await assert.rejects(() => resolveSandboxLaunch({ enabled: true, backend: "test-down" }, ARGV, "/work"), /unavailable|fail-closed/i);
});

test("resolveSandboxLaunch: unknown backend is rejected", async () => {
  await assert.rejects(() => resolveSandboxLaunch({ enabled: true, backend: "nope" }, ARGV, "/work"), /Unknown sandbox backend/);
});

test("the default backends are registered", () => {
  const ids = sandboxBackendIds();
  assert.ok(ids.includes("none"));
  assert.ok(ids.includes("apple-container"));
});
