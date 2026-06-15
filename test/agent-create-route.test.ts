import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { GaiaWebServer } from "../src/web/server.ts";
import { initWorkspace } from "../src/workspace/workspace-loader.ts";

// ----------------------------------------------------------------
// Helpers – tiny HTTP client on top of Node built-ins
// ----------------------------------------------------------------

interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function httpReq(method: string, url: string, jsonBody?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
    const req = httpRequest(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: postData
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(postData).toString(),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ----------------------------------------------------------------
// HTTP-level POST /api/agents tests
// ----------------------------------------------------------------

describe("POST /api/agents (HTTP)", () => {
  const origHome = process.env.GAIA_HOME;
  const tag = randomBytes(6).toString("hex");
  let gaiaHomeDir: string;
  let workspaceDir: string;
  let server: Awaited<ReturnType<GaiaWebServer["listen"]>>;
  let baseUrl: string;

  before(async () => {
    gaiaHomeDir = join(tmpdir(), `gaia-test-home-${tag}`);
    workspaceDir = join(tmpdir(), `gaia-test-ws-${tag}`);

    await mkdir(gaiaHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    process.env.GAIA_HOME = gaiaHomeDir;

    // Initialize a workspace so the registry finds it on startup
    await initWorkspace(workspaceDir);

    const ws = new GaiaWebServer({ cwd: workspaceDir, port: 0, host: "127.0.0.1" });
    server = await ws.listen();
    baseUrl = server.url.replace(/\/$/, "");
  });

  after(async () => {
    process.env.GAIA_HOME = origHome;
    if (server) await server.close();
    if (gaiaHomeDir) await rm(gaiaHomeDir, { recursive: true, force: true });
    if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
  });

  test("creates agent and returns 201", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "stella" });
    assert.equal(res.status, 201);
    const b = res.body as Record<string, unknown>;
    const agent = b.agent as Record<string, unknown>;
    assert.equal(agent.id, "stella");
    assert.equal(agent.displayName, "Stella");
    assert.ok(typeof agent.dir === "string" && agent.dir.length > 0);

    const configPath = join(gaiaHomeDir, "agents", "stella", "agent.json");
    assert.ok(existsSync(configPath));
  });

  test("uses provided displayName", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "nova-2", displayName: "Super Nova" });
    assert.equal(res.status, 201);
    const agent = (res.body as Record<string, unknown>).agent as Record<string, unknown>;
    assert.equal(agent.displayName, "Super Nova");
  });

  test("stores icon on disk", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "luna-2", icon: "🌙" });
    assert.equal(res.status, 201);
    const raw = JSON.parse(await readFile(join(gaiaHomeDir, "agents", "luna-2", "agent.json"), "utf8"));
    assert.equal(raw.icon, "🌙");
  });

  test("falls back to title-cased id when displayName is whitespace", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "my-agent-2", displayName: "   " });
    assert.equal(res.status, 201);
    const agent = (res.body as Record<string, unknown>).agent as Record<string, unknown>;
    assert.equal(agent.displayName, "My Agent 2");
  });

  test("title-cases kebab-case id", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "code-reviewer" });
    assert.equal(res.status, 201);
    const agent = (res.body as Record<string, unknown>).agent as Record<string, unknown>;
    assert.equal(agent.displayName, "Code Reviewer");
  });

  test("title-cases snake_case id", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "bug_hunter" });
    assert.equal(res.status, 201);
    const agent = (res.body as Record<string, unknown>).agent as Record<string, unknown>;
    assert.equal(agent.displayName, "Bug Hunter");
  });

  test("returns 400 when id is missing", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { displayName: "Who" });
    assert.equal(res.status, 400);
    assert.equal((res.body as Record<string, unknown>).error, "Missing agent id");
  });

  test("returns 400 when body is empty", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, {});
    assert.equal(res.status, 400);
    assert.equal((res.body as Record<string, unknown>).error, "Missing agent id");
  });

  test("returns 400 for invalid agent id", async () => {
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "bad id!" });
    assert.equal(res.status, 400);
    const err = (res.body as Record<string, unknown>).error as string;
    assert.ok(err.includes("Invalid agent id"));
  });

  test("returns 409 for duplicate agent id", async () => {
    await httpReq("POST", `${baseUrl}/api/agents`, { id: "dup-me" });
    const res = await httpReq("POST", `${baseUrl}/api/agents`, { id: "dup-me" });
    assert.equal(res.status, 409);
    const err = (res.body as Record<string, unknown>).error as string;
    assert.ok(err.includes("Agent already exists"));
  });

  test("keeps /api/app reachable after agent creation", async () => {
    await httpReq("POST", `${baseUrl}/api/agents`, { id: "smoke" });
    const app = await httpReq("GET", `${baseUrl}/api/app`);
    assert.equal(app.status, 200);
    const b = app.body as Record<string, unknown>;
    assert.ok(Array.isArray(b.workspaces));
    assert.ok(typeof b.currentWorkspaceId === "string");
  });

  test("titleCaseId edge cases: single, multi-dash, underscore, mixed", async () => {
    const cases = [
      { id: "neo", want: "Neo" },
      { id: "x-y-z", want: "X Y Z" },
      { id: "a_b_c", want: "A B C" },
      { id: "mix-ed_up", want: "Mix Ed Up" },
    ];
    for (const { id, want } of cases) {
      const res = await httpReq("POST", `${baseUrl}/api/agents`, { id });
      assert.equal(res.status, 201);
      assert.equal((res.body as Record<string, unknown>).agent.displayName, want);
    }
  });
});

// ----------------------------------------------------------------
// Library-level tests (keep existing scaffold coverage)
// ----------------------------------------------------------------

import { scaffoldGlobalAgent } from "../src/agents/scaffold.ts";
import { loadAgentDefinitions } from "../src/agents/registry.ts";
import { createTempDir } from "./helpers/temp.ts";

test("scaffolded agent appears in agent definitions", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const projectAgentsDir = join(temp.path, ".gaia", "agents");

    const result = await scaffoldGlobalAgent(agentsDir, "nova", { displayName: "Nova" });
    assert.ok(result.agentDir);

    const definitions = await loadAgentDefinitions(agentsDir, projectAgentsDir);
    assert.ok(definitions["nova"]);
    assert.equal(definitions["nova"].id, "nova");
    assert.equal(definitions["nova"].displayName, "Nova");
    assert.ok(definitions["nova"].tools.length > 0);
  } finally {
    await temp.cleanup();
  }
});

test("scaffolded agent with no display name uses title-cased id", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const projectAgentsDir = join(temp.path, ".gaia", "agents");

    await scaffoldGlobalAgent(agentsDir, "my-agent");
    const definitions = await loadAgentDefinitions(agentsDir, projectAgentsDir);
    assert.equal(definitions["my-agent"].displayName, "My Agent");
  } finally {
    await temp.cleanup();
  }
});

test("scaffolded agent with custom icon appears in definition", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    const projectAgentsDir = join(temp.path, ".gaia", "agents");

    await scaffoldGlobalAgent(agentsDir, "luna", { icon: "🌙" });
    const definitions = await loadAgentDefinitions(agentsDir, projectAgentsDir);
    assert.equal(definitions["luna"].icon, "🌙");
  } finally {
    await temp.cleanup();
  }
});

test("duplicate agent id is refused by scaffold", async () => {
  const temp = await createTempDir();
  try {
    const agentsDir = join(temp.path, "agents");
    await scaffoldGlobalAgent(agentsDir, "only");
    await assert.rejects(() => scaffoldGlobalAgent(agentsDir, "only"), /Agent already exists/);
  } finally {
    await temp.cleanup();
  }
});
