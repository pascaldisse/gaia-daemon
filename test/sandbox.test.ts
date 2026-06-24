import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSandbox,
  resolveSandboxLaunch,
  resolveSandboxPolicy,
  sandboxBackendIds,
} from "../src/runtime/sandbox/index.ts";
import { buildSeatbeltProfile } from "../src/runtime/sandbox/macos-seatbelt.ts";
import { buildContainerArgs } from "../src/runtime/sandbox/apple-container.ts";

const ARGV = ["/usr/bin/node", "cli.js", "__run-agent"];
const DARWIN = { platform: "darwin" };

test("resolveSandboxPolicy: trusted top-level off, trusted summon on with a real backend", () => {
  assert.equal(resolveSandboxPolicy(undefined, undefined, false, DARWIN).enabled, false);
  const summon = resolveSandboxPolicy(undefined, undefined, true, DARWIN);
  assert.equal(summon.enabled, true);
  assert.equal(summon.backend, "macos-seatbelt"); // never "none" by default — summons are never naked
});

test("resolveSandboxPolicy: a trusted agent may still override a summon back to none", () => {
  const policy = resolveSandboxPolicy(undefined, { enabled: false, backend: "none" }, true, DARWIN);
  assert.equal(policy.enabled, false);
  assert.equal(policy.backend, "none");
});

test("resolveSandboxPolicy: untrusted agents are forced into a real backend, top-level included", () => {
  const policy = resolveSandboxPolicy(undefined, undefined, false, { ...DARWIN, trusted: false });
  assert.equal(policy.enabled, true);
  assert.equal(policy.backend, "macos-seatbelt");
});

test("resolveSandboxPolicy: an untrusted agent CANNOT configure its way out of the sandbox", () => {
  // Every attempt to weaken isolation is ignored for an untrusted agent.
  const off = resolveSandboxPolicy({ enabled: false, backend: "none" }, { enabled: false, backend: "none" }, false, { ...DARWIN, trusted: false });
  assert.equal(off.enabled, true);
  assert.equal(off.backend, "macos-seatbelt");
});

test("resolveSandboxPolicy: an untrusted agent may pick a DIFFERENT real backend, just not none", () => {
  const policy = resolveSandboxPolicy(undefined, { backend: "apple-container" }, false, { ...DARWIN, trusted: false });
  assert.equal(policy.backend, "apple-container");
});

test("resolveSandboxPolicy: agent override beats workspace default", () => {
  const policy = resolveSandboxPolicy({ enabled: false, backend: "apple-container" }, { enabled: true }, false, DARWIN);
  assert.equal(policy.enabled, true);
  assert.equal(policy.backend, "apple-container");
});

test("resolveSandboxLaunch: disabled or none backend is the identity launch", async () => {
  const off = await resolveSandboxLaunch({ enabled: false }, ARGV, "/work");
  assert.deepEqual(off, { command: "/usr/bin/node", args: ["cli.js", "__run-agent"] });
  const none = await resolveSandboxLaunch({ enabled: true, backend: "none" }, ARGV, "/work");
  assert.deepEqual(none, { command: "/usr/bin/node", args: ["cli.js", "__run-agent"] });
});

test("resolveSandboxLaunch: merges caller writable/readonly into the spec the backend sees", async () => {
  let seen: { writable: string[]; readonly: string[] } | undefined;
  registerSandbox({
    id: "test-spy",
    available: () => true,
    wrap: (spec) => {
      seen = { writable: spec.writable, readonly: spec.readonly };
      return { command: "isolate", args: spec.argv };
    },
  });
  await resolveSandboxLaunch({ enabled: true, backend: "test-spy", writable: ["/extra"] }, ARGV, "/work", {
    writable: ["/scratch"],
    readonly: ["/work/.gaia/config.json"],
  });
  assert.deepEqual(seen?.writable, ["/extra", "/scratch"]);
  assert.deepEqual(seen?.readonly, ["/work/.gaia/config.json"]);
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
  assert.ok(ids.includes("macos-seatbelt"));
  assert.ok(ids.includes("apple-container"));
});

test("buildSeatbeltProfile: confines writes to the workspace, carves out policy files + auth, honours net", () => {
  const profile = buildSeatbeltProfile({
    argv: ARGV,
    cwd: "/work",
    writable: ["/scratch"],
    readonly: ["/work/.gaia/config.json"],
    forwardEnv: [],
    net: "none",
  });
  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\(deny file-write\*\)/); // writes denied by default...
  assert.match(profile, /\(allow file-write\*[^\n]*subpath "\/work"/); // ...except the workspace
  assert.match(profile, /subpath "\/scratch"/); // ...and extra writable
  assert.match(profile, /deny file-write\*[^\n]*subpath "\/work\/.gaia\/config.json"/); // ...but never the policy file
  assert.match(profile, /deny file-write\*[^\n]*auth\.json/); // ...nor the pi credential store
  assert.match(profile, /\(deny network\*\)/); // net: none
});

test("buildSeatbeltProfile: leaves network alone when net is full", () => {
  const profile = buildSeatbeltProfile({ argv: ARGV, cwd: "/work", writable: [], readonly: [], forwardEnv: [], net: "full" });
  assert.doesNotMatch(profile, /deny network/);
});

test("buildContainerArgs: workspace rw, image gaia (not host argv), env forwarded by name", () => {
  const args = buildContainerArgs({
    argv: ARGV,
    cwd: "/work",
    writable: ["/work/scratch"],
    readonly: ["/work/.gaia/config.json"], // does not exist in test → carve-out skipped (existsSync guard)
    forwardEnv: ["GAIA_DAEMON_TOKEN", "DEEPSEEK_API_KEY"],
    net: "none",
  });
  const s = args.join(" ");
  assert.ok(s.startsWith("run --rm -i -w /work"));
  assert.match(s, /-v \/work:\/work\b/); // workspace mounted READ-WRITE (no :ro)
  assert.doesNotMatch(s, /-v \/work:\/work:ro/);
  assert.match(s, /-v \/work\/scratch:\/work\/scratch/); // extra writable grant
  assert.match(s, /-e GAIA_DAEMON_TOKEN/); // env forwarded by NAME (value not embedded)
  assert.match(s, /-e DEEPSEEK_API_KEY/);
  assert.doesNotMatch(s, /secret|=.*KEY/); // no values in argv
  assert.match(s, /--net none/);
  assert.ok(s.endsWith("node /opt/gaia/dist/cli.js __run-agent")); // runs the image's gaia
  assert.ok(!s.includes(ARGV[0])); // the host node path is NOT pushed into the guest
});

test("end-to-end on darwin: an untrusted policy resolves to a real sandbox-exec launch wrapping the argv", { skip: process.platform !== "darwin" }, async () => {
  const policy = resolveSandboxPolicy(undefined, undefined, false, { trusted: false, platform: "darwin" });
  const launch = await resolveSandboxLaunch(policy, ARGV, "/work", { readonly: ["/work/.gaia/config.json"] });
  assert.equal(launch.command, "/usr/bin/sandbox-exec");
  assert.equal(launch.args[0], "-p");
  assert.ok(launch.args[1].includes("config.json")); // the policy-file carve-out made it into the profile
  assert.deepEqual(launch.args.slice(-ARGV.length), ARGV); // the real launch is wrapped verbatim
});
