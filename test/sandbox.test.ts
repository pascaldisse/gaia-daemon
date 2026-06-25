import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSandbox,
  resolveSandboxLaunch,
  resolveSandboxPolicy,
  sandboxBackendIds,
} from "../src/runtime/sandbox/index.ts";
import { buildSeatbeltProfile } from "../src/runtime/sandbox/macos-seatbelt.ts";

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
  const policy = resolveSandboxPolicy(undefined, { backend: "custom-real" }, false, { ...DARWIN, trusted: false });
  assert.equal(policy.backend, "custom-real");
});

test("resolveSandboxPolicy: agent override beats workspace default", () => {
  const policy = resolveSandboxPolicy({ enabled: false, backend: "custom-real" }, { enabled: true }, false, DARWIN);
  assert.equal(policy.enabled, true);
  assert.equal(policy.backend, "custom-real");
});

test("resolveSandboxPolicy: credentialProxy is off by default, opt-in via agent or workspace", () => {
  assert.equal(resolveSandboxPolicy(undefined, undefined, true, DARWIN).credentialProxy, false);
  assert.equal(resolveSandboxPolicy({ credentialProxy: true }, undefined, false, DARWIN).credentialProxy, true);
  assert.equal(resolveSandboxPolicy(undefined, { credentialProxy: true }, false, DARWIN).credentialProxy, true);
  // Agent override wins, including turning it back off.
  assert.equal(resolveSandboxPolicy({ credentialProxy: true }, { credentialProxy: false }, false, DARWIN).credentialProxy, false);
  // Survives the untrusted forced-sandbox path too.
  assert.equal(resolveSandboxPolicy({ credentialProxy: true }, undefined, false, { ...DARWIN, trusted: false }).credentialProxy, true);
});

test("resolveSandboxLaunch: disabled or none backend is the identity launch", async () => {
  const off = await resolveSandboxLaunch({ enabled: false }, ARGV, "/work");
  assert.deepEqual(off, { command: "/usr/bin/node", args: ["cli.js", "__run-agent"] });
  const none = await resolveSandboxLaunch({ enabled: true, backend: "none" }, ARGV, "/work");
  assert.deepEqual(none, { command: "/usr/bin/node", args: ["cli.js", "__run-agent"] });
});

test("resolveSandboxLaunch: merges caller writable/readonly/denyRead/cwdWritable into the spec the backend sees", async () => {
  let seen: { writable: string[]; readonly: string[]; denyRead?: string[]; cwdWritable?: boolean } | undefined;
  registerSandbox({
    id: "test-spy",
    available: () => true,
    wrap: (spec) => {
      seen = { writable: spec.writable, readonly: spec.readonly, denyRead: spec.denyRead, cwdWritable: spec.cwdWritable };
      return { command: "isolate", args: spec.argv };
    },
  });
  await resolveSandboxLaunch({ enabled: true, backend: "test-spy", writable: ["/extra"] }, ARGV, "/work", {
    writable: ["/scratch"],
    readonly: ["/work/.gaia/config.json"],
    denyRead: ["/secret"],
    cwdWritable: false,
  });
  assert.deepEqual(seen?.writable, ["/extra", "/scratch"]);
  assert.deepEqual(seen?.readonly, ["/work/.gaia/config.json"]);
  assert.deepEqual(seen?.denyRead, ["/secret"]);
  assert.equal(seen?.cwdWritable, false);
});

test("resolveSandboxLaunch: fails closed when an enabled backend is unavailable", async () => {
  registerSandbox({ id: "test-down", available: () => false, wrap: (spec) => ({ command: spec.argv[0], args: [] }) });
  await assert.rejects(() => resolveSandboxLaunch({ enabled: true, backend: "test-down" }, ARGV, "/work"), /unavailable|fail-closed/i);
});

test("resolveSandboxLaunch: unknown backend is rejected", async () => {
  await assert.rejects(() => resolveSandboxLaunch({ enabled: true, backend: "nope" }, ARGV, "/work"), /Unknown sandbox backend/);
});

test("the default backends are registered; apple-container is gone", () => {
  const ids = sandboxBackendIds();
  assert.ok(ids.includes("none"));
  assert.ok(ids.includes("macos-seatbelt"));
  assert.ok(!ids.includes("apple-container")); // dropped
});

test("buildSeatbeltProfile: confines writes to the workspace, carves out policy files + auth, honours net", () => {
  const profile = buildSeatbeltProfile({
    argv: ARGV,
    cwd: "/work",
    writable: ["/scratch"],
    readonly: ["/work/.gaia/config.json"],
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
  const profile = buildSeatbeltProfile({ argv: ARGV, cwd: "/work", writable: [], readonly: [], net: "full" });
  assert.doesNotMatch(profile, /deny network/);
});

test("buildSeatbeltProfile: denies reads of the sensitive set and re-allows the workspace", () => {
  const profile = buildSeatbeltProfile({ argv: ARGV, cwd: "/work", writable: [], readonly: [], net: "full" });
  assert.match(profile, /\(deny file-read\*[^\n]*\.ssh/); // SSH keys hidden
  assert.match(profile, /\(deny file-read\*[^\n]*\.aws/); // cloud creds hidden
  assert.match(profile, /\(allow file-read\*[^\n]*subpath "\/work"/); // ...but the workspace is re-allowed on top
});

test("buildSeatbeltProfile: extra denyRead paths are honoured", () => {
  const profile = buildSeatbeltProfile({ argv: ARGV, cwd: "/work", writable: [], readonly: [], denyRead: ["/secret/zone"], net: "full" });
  assert.match(profile, /\(deny file-read\*[^\n]*\/secret\/zone/);
});

test("buildSeatbeltProfile: cwdWritable=false keeps the repo read-only but still readable", () => {
  const profile = buildSeatbeltProfile({ argv: ARGV, cwd: "/repo", writable: ["/scratch"], readonly: [], cwdWritable: false, net: "full" });
  assert.doesNotMatch(profile, /allow file-write\*[^\n]*subpath "\/repo"/); // repo NOT writable
  assert.match(profile, /allow file-write\*[^\n]*subpath "\/scratch"/); // scratch is
  assert.match(profile, /allow file-read\*[^\n]*subpath "\/repo"/); // repo still readable
});

test("__sandbox-exec: backend none runs the child directly and propagates its exit code", async () => {
  const { runSandboxExec } = await import("../src/runtime/sandbox/exec-cli.ts");
  const code = await runSandboxExec(["--backend", "none", "--", process.execPath, "-e", "process.exit(7)"]);
  assert.equal(code, 7);
});

test("__sandbox-exec: fails closed (child never runs) when the backend is unavailable", async () => {
  const { runSandboxExec } = await import("../src/runtime/sandbox/exec-cli.ts");
  registerSandbox({ id: "exec-down", available: () => false, wrap: (spec) => ({ command: spec.argv[0], args: [] }) });
  const code = await runSandboxExec(["--backend", "exec-down", "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(code, 1); // refused; the child (which would exit 0) never ran
});

test("__sandbox-exec: requires a -- separator before the child command", async () => {
  const { runSandboxExec } = await import("../src/runtime/sandbox/exec-cli.ts");
  assert.equal(await runSandboxExec(["--backend", "none"]), 2);
});

test("end-to-end on darwin: an untrusted policy resolves to a real sandbox-exec launch wrapping the argv", { skip: process.platform !== "darwin" }, async () => {
  const policy = resolveSandboxPolicy(undefined, undefined, false, { trusted: false, platform: "darwin" });
  const launch = await resolveSandboxLaunch(policy, ARGV, "/work", { readonly: ["/work/.gaia/config.json"] });
  assert.equal(launch.command, "/usr/bin/sandbox-exec");
  assert.equal(launch.args[0], "-p");
  assert.ok(launch.args[1].includes("config.json")); // the policy-file carve-out made it into the profile
  assert.deepEqual(launch.args.slice(-ARGV.length), ARGV); // the real launch is wrapped verbatim
});
