import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Workspace } from "../src/core/types.js";
import "../src/harness/index.js";
import { RunnerHost } from "../src/harness/host.js";
import type { SandboxPolicy } from "../src/harness/sandbox/spec.js";

function makeHost(root: string, incognito = false, configEnv?: Record<string, string>): RunnerHost {
  const workspace = { rootDir: root, roomsDir: join(root, ".gaia", "rooms"), configPath: join(root, ".gaia", "config.json"), agentsOverrideDir: join(root, ".gaia", "agents"), ...(configEnv ? { config: { env: configEnv } } : {}) } as unknown as Workspace;
  const agent = { id: "scout", memoryDir: join(root, "mem"), model: { provider: "deepseek", name: "deepseek-v4-pro" } } as unknown as AgentDef;
  return new RunnerHost({ workspace, agent, harness: "pi", ...(incognito ? { incognito: true } : {}), harnessHost: () => ({ baseUrl: "http://127.0.0.1:9999", llmProxyUrl: "http://127.0.0.1:9999/api/harness/llm", mintToken: () => "tok-123" }), allowSummon: () => true, sandbox: () => ({ enabled: true, backend: "macos-seatbelt" }) });
}
function envFor(host: RunnerHost, roomId: string, policy: SandboxPolicy): NodeJS.ProcessEnv {
  return (host as unknown as { envFor(r: string, p: SandboxPolicy): NodeJS.ProcessEnv }).envFor(roomId, policy);
}
const PROXY_ON: SandboxPolicy = { enabled: true, backend: "macos-seatbelt", credentialProxy: true };
const PROXY_OFF: SandboxPolicy = { enabled: true, backend: "macos-seatbelt", credentialProxy: false };
function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gaia-proxy-"));
  const previous = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  try {
    process.env.DEEPSEEK_API_KEY = "sk-real-deepseek";
    process.env.OPENAI_API_KEY = "sk-real-openai";
    process.env.ANTHROPIC_API_KEY = "sk-real-anthropic";
    fn(root);
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(root, { recursive: true, force: true });
  }
}

test("Pi proxy strips provider keys and materializes an empty isolated auth store", () => {
  withTemp((root) => {
    const childEnv = envFor(makeHost(root), "room1", PROXY_ON);
    assert.equal(childEnv.DEEPSEEK_API_KEY, undefined);
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.GAIA_LLM_PROXY_URL, "http://127.0.0.1:9999/api/harness/llm");
    assert.equal(childEnv.GAIA_DAEMON_TOKEN, "tok-123");
    const scratch = join(root, ".gaia", "rooms", "room1", "proxy-scratch");
    assert.equal(childEnv.PI_CODING_AGENT_DIR, scratch);
    assert.equal(readFileSync(join(scratch, "auth.json"), "utf8").trim(), "{}");
    assert.ok(existsSync(join(scratch, "auth.json")));
  });
});

test("Pi proxy-off and incognito env retain the expected runner flags", () => {
  withTemp((root) => {
    const direct = envFor(makeHost(root), "room1", PROXY_OFF);
    assert.equal(direct.DEEPSEEK_API_KEY, "sk-real-deepseek");
    assert.equal(direct.GAIA_LLM_PROXY_URL, undefined);
    assert.equal(direct.GAIA_RUNNER_HARNESS, "pi");
    const incognito = envFor(makeHost(root, true), "room1", PROXY_OFF);
    assert.equal(incognito.GAIA_RUNNER_INCOGNITO, "1");
  });
});
