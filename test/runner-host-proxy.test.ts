// Verifies the daemon-side env the RunnerHost hands a proxied turn: the real
// provider keys are stripped, the proxy URL + relocated cred dir are set, and a
// valid-but-empty auth.json is materialized — and that all of this is gated to the
// pi harness with the credentialProxy flag on (so ordinary turns are untouched).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerHost } from "../src/runtime/runner-host.ts";
import { findHarness, registerHarness } from "../src/runtime/harness-registry.ts";
import type { SandboxPolicy } from "../src/runtime/sandbox/index.ts";

// Stub specs so the test stands alone (it never constructs the real runtimes — it
// only calls buildEnv). Register only when absent, so we never clobber a real spec
// another test file in this process depends on.
const STUB_CAPS = { gaiaTools: [], granularTools: true, supportsPermissionMode: false } as never;
for (const id of ["pi", "claude"]) {
  if (!findHarness(id)) registerHarness({ id, capabilities: STUB_CAPS, ui: { label: id, description: id }, create: () => ({}) as never });
}

function makeHost(harness: string, root: string): RunnerHost {
  const workspace = {
    rootDir: root,
    roomsDir: join(root, ".gaia", "rooms"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
  } as never;
  const agent = { id: "scout", memoryDir: join(root, "mem"), model: { provider: "deepseek", name: "deepseek-v4-pro" } } as never;
  return new RunnerHost({
    workspace,
    agent,
    harness,
    harnessHost: () => ({ baseUrl: "http://127.0.0.1:9999", llmProxyUrl: "http://127.0.0.1:9999/api/harness/llm", mintToken: () => "tok-123" }),
    allowSummon: () => true,
    sandbox: () => ({ enabled: true, backend: "macos-seatbelt" }),
  });
}

const PROXY_ON: SandboxPolicy = { enabled: true, backend: "macos-seatbelt", credentialProxy: true };
const PROXY_OFF: SandboxPolicy = { enabled: true, backend: "macos-seatbelt", credentialProxy: false };

test("buildEnv: a proxied pi turn strips provider keys, sets the proxy URL, relocates the cred dir", () => {
  const root = mkdtempSync(join(tmpdir(), "gaia-proxy-"));
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-REAL-must-not-leak";
    process.env.OPENAI_API_KEY = "sk-REAL-2";
    const host = makeHost("pi", root);
    const env = (host as unknown as { buildEnv(roomId: string, policy: SandboxPolicy): NodeJS.ProcessEnv }).buildEnv("room1", PROXY_ON);

    assert.equal(env.DEEPSEEK_API_KEY, undefined); // the real key never reaches the child
    assert.equal(env.OPENAI_API_KEY, undefined); // every provider key, not just the configured one
    assert.equal(env.GAIA_LLM_PROXY_URL, "http://127.0.0.1:9999/api/harness/llm");
    assert.equal(env.GAIA_DAEMON_TOKEN, "tok-123"); // proxy reuses the bridge token
    const scratch = join(root, ".gaia", "rooms", "room1", "pi-agent-dir");
    assert.equal(env.PI_CODING_AGENT_DIR, scratch);
    assert.ok(existsSync(join(scratch, "auth.json"))); // materialized...
    assert.equal(readFileSync(join(scratch, "auth.json"), "utf8").trim(), "{}"); // ...and empty (no real key)
  } finally {
    process.env.DEEPSEEK_API_KEY = prevKey;
    process.env.OPENAI_API_KEY = prevOpenai;
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildEnv: proxy OFF leaves provider keys in place and sets no proxy env", () => {
  const root = mkdtempSync(join(tmpdir(), "gaia-proxy-"));
  const prev = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-stays";
    const env = (makeHost("pi", root) as unknown as { buildEnv(r: string, p: SandboxPolicy): NodeJS.ProcessEnv }).buildEnv("room1", PROXY_OFF);
    assert.equal(env.DEEPSEEK_API_KEY, "sk-stays");
    assert.equal(env.GAIA_LLM_PROXY_URL, undefined);
    assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  } finally {
    process.env.DEEPSEEK_API_KEY = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildEnv: the proxy is pi-only — a claude turn keeps its keys even with the flag on", () => {
  const root = mkdtempSync(join(tmpdir(), "gaia-proxy-"));
  const prev = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-stays";
    const env = (makeHost("claude", root) as unknown as { buildEnv(r: string, p: SandboxPolicy): NodeJS.ProcessEnv }).buildEnv("room1", PROXY_ON);
    assert.equal(env.DEEPSEEK_API_KEY, "sk-stays"); // claude redirect is future work
    assert.equal(env.GAIA_LLM_PROXY_URL, undefined);
  } finally {
    process.env.DEEPSEEK_API_KEY = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
