// Verifies the daemon-side env the RunnerHost hands a proxied turn, and that the
// credential proxy is UNIFORM across harnesses — every harness's egress is routed
// through the proxy via the wiring it declares on its spec, with the real provider
// keys stripped. There is NO per-harness gate (AGENTS.md §RULE #0): pi, claude, and
// codex all flow through the same mechanism; only their declared env differs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Workspace } from "../src/core/types.js";
import "../src/harness/index.js"; // register the real harnesses + their credentialProxy descriptors
import { RunnerHost } from "../src/harness/host.js";
import type { SandboxPolicy } from "../src/harness/sandbox/spec.js";

function makeHost(harness: string, root: string, incognito = false): RunnerHost {
  const workspace = {
    rootDir: root,
    roomsDir: join(root, ".gaia", "rooms"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
  } as unknown as Workspace;
  const agent = { id: "scout", memoryDir: join(root, "mem"), model: { provider: "deepseek", name: "deepseek-v4-pro" } } as unknown as AgentDef;
  return new RunnerHost({
    workspace,
    agent,
    harness,
    ...(incognito ? { incognito: true } : {}),
    harnessHost: () => ({ baseUrl: "http://127.0.0.1:9999", llmProxyUrl: "http://127.0.0.1:9999/api/harness/llm", mintToken: () => "tok-123" }),
    allowSummon: () => true,
    sandbox: () => ({ enabled: true, backend: "macos-seatbelt" }),
  });
}

// The private test seam that resolves the bridge token + harness proxy wiring and
// returns the full child env, exactly as spawnChild does.
function envFor(host: RunnerHost, roomId: string, policy: SandboxPolicy): NodeJS.ProcessEnv {
  return (host as unknown as { envFor(r: string, p: SandboxPolicy): NodeJS.ProcessEnv }).envFor(roomId, policy);
}

const PROXY_ON: SandboxPolicy = { enabled: true, backend: "macos-seatbelt", credentialProxy: true };
const PROXY_OFF: SandboxPolicy = { enabled: true, backend: "macos-seatbelt", credentialProxy: false };

function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gaia-proxy-"));
  const prevKeys = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  try {
    process.env.DEEPSEEK_API_KEY = "sk-REAL-must-not-leak";
    process.env.OPENAI_API_KEY = "sk-REAL-2";
    process.env.ANTHROPIC_API_KEY = "sk-REAL-3";
    fn(root);
  } finally {
    for (const [k, v] of Object.entries(prevKeys)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(root, { recursive: true, force: true });
  }
}

test("proxy ON, pi: strips every provider key, sets the proxy URL + token, relocates the cred dir to an empty store", () => {
  withTemp((root) => {
    const env = envFor(makeHost("pi", root), "room1", PROXY_ON);
    assert.equal(env.DEEPSEEK_API_KEY, undefined); // the real key never reaches the child
    assert.equal(env.OPENAI_API_KEY, undefined); // every provider key, not just the configured one
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GAIA_LLM_PROXY_URL, "http://127.0.0.1:9999/api/harness/llm");
    assert.equal(env.GAIA_DAEMON_TOKEN, "tok-123"); // proxy reuses the bridge token
    const scratch = join(root, ".gaia", "rooms", "room1", "proxy-scratch");
    assert.equal(env.PI_CODING_AGENT_DIR, scratch); // pi's declared wiring
    assert.ok(existsSync(join(scratch, "auth.json"))); // materialized...
    assert.equal(readFileSync(join(scratch, "auth.json"), "utf8").trim(), "{}"); // ...and empty (no real key)
  });
});

test("proxy ON, claude: SAME mechanism — strips keys, sets proxy URL, plus claude's declared ANTHROPIC_* wiring", () => {
  withTemp((root) => {
    const env = envFor(makeHost("claude", root), "room1", PROXY_ON);
    assert.equal(env.DEEPSEEK_API_KEY, undefined); // uniform: claude is NOT exempt
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GAIA_LLM_PROXY_URL, "http://127.0.0.1:9999/api/harness/llm");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999/api/harness/llm"); // claude's egress redirect
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok-123"); // token in place of the real key
    assert.equal(env.PI_CODING_AGENT_DIR, undefined); // pi-specific wiring does NOT leak to claude
  });
});

test("proxy ON, codex: SAME mechanism — strips keys, plus codex's declared OPENAI_* wiring", () => {
  withTemp((root) => {
    const env = envFor(makeHost("codex", root), "room1", PROXY_ON);
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.GAIA_LLM_PROXY_URL, "http://127.0.0.1:9999/api/harness/llm");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:9999/api/harness/llm"); // codex's egress redirect
    assert.equal(env.OPENAI_API_KEY, "tok-123"); // token in place of the real key (wiring applies AFTER the strip)
  });
});

test("proxy OFF: every harness keeps its provider keys and no proxy wiring is added", () => {
  for (const harness of ["pi", "claude", "codex"]) {
    withTemp((root) => {
      const env = envFor(makeHost(harness, root), "room1", PROXY_OFF);
      // Keys are left in place and NO redirect is injected. (Base-url env vars are
      // not asserted absent — the host shell may legitimately export its own, and
      // proxy-off must pass inherited env through untouched.)
      assert.equal(env.DEEPSEEK_API_KEY, "sk-REAL-must-not-leak", `${harness} keeps keys when proxy off`);
      assert.equal(env.ANTHROPIC_API_KEY, "sk-REAL-3", `${harness} keeps keys when proxy off`);
      assert.equal(env.GAIA_LLM_PROXY_URL, undefined);
      assert.equal(env.PI_CODING_AGENT_DIR, undefined);
    });
  }
});

test("the runner env carries the uniform RUNNER_ENV keys for any harness", () => {
  withTemp((root) => {
    const env = envFor(makeHost("pi", root), "room1", PROXY_OFF);
    assert.equal(env.GAIA_RUNNER_WORKSPACE, root);
    assert.equal(env.GAIA_RUNNER_AGENT, "scout");
    assert.equal(env.GAIA_RUNNER_HARNESS, "pi");
    assert.equal(env.GAIA_ROOM_ID, "room1");
    assert.equal(env.GAIA_MEMORY_DIR, join(root, "mem"));
    assert.equal(env.GAIA_ROOM_DIR, join(root, ".gaia", "rooms", "room1"));
    assert.equal(env.GAIA_AGENT_ID, "scout"); // the gaia-CLI bridge's public agent id — set HERE, once, for every harness

    assert.equal(env.GAIA_DAEMON_URL, "http://127.0.0.1:9999"); // bridge target rides even without the proxy
    assert.equal(env.GAIA_DAEMON_TOKEN, "tok-123");
    // A normal room does NOT set the incognito flag.
    assert.equal(env.GAIA_RUNNER_INCOGNITO, undefined);
  });
});

test("an incognito room sets GAIA_RUNNER_INCOGNITO=1 so the runner strips memory/recall (any harness)", () => {
  withTemp((root) => {
    for (const harness of ["pi", "claude", "codex"]) {
      const env = envFor(makeHost(harness, root, true), "room1", PROXY_OFF);
      assert.equal(env.GAIA_RUNNER_INCOGNITO, "1", `${harness}: incognito flag reaches the runner env`);
    }
  });
});
