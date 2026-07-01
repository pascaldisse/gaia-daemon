import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpServers, parseWorkspaceConfig, resolveMcpServers } from "../src/core/config.js";
import { codexMcpServersConfig } from "../src/harness/codex.js";

test("parseMcpServers: tolerant — needs command or url, drops junk", () => {
  const servers = parseMcpServers({
    fs: { command: "npx", args: ["-y", "server-filesystem", 42], env: { ROOT: "/tmp", BAD: 7 } },
    linear: { url: "https://mcp.linear.app/sse" },
    empty: {},
    "bad name!": { command: "x" },
    junk: "nope",
  });
  assert.deepEqual(Object.keys(servers ?? {}).sort(), ["fs", "linear"]);
  assert.deepEqual(servers?.fs, { command: "npx", args: ["-y", "server-filesystem"], env: { ROOT: "/tmp" } });
  assert.deepEqual(servers?.linear, { url: "https://mcp.linear.app/sse" });
  assert.equal(parseMcpServers(undefined), undefined);
  assert.equal(parseMcpServers({}), undefined);
});

test("resolveMcpServers: workspace ∪ agent, agent wins per name", () => {
  const workspace = { mcpServers: { fs: { command: "old" }, linear: { url: "https://mcp.linear.app/sse" } } };
  const agent = { mcpServers: { fs: { command: "new" } } };
  assert.deepEqual(resolveMcpServers(workspace, agent), {
    fs: { command: "new" },
    linear: { url: "https://mcp.linear.app/sse" },
  });
  assert.deepEqual(resolveMcpServers({}, {}), {});
});

test("parseWorkspaceConfig carries mcpServers", () => {
  const config = parseWorkspaceConfig({ mcpServers: { fs: { command: "npx" } } }, () => true);
  assert.deepEqual(config.mcpServers, { fs: { command: "npx" } });
  assert.equal(parseWorkspaceConfig({}, () => true).mcpServers, undefined);
});

test("codexMcpServersConfig maps the neutral shape onto mcp_servers tables", () => {
  assert.deepEqual(
    codexMcpServersConfig({
      fs: { command: "npx", args: ["-y", "x"], env: { A: "1" } },
      linear: { url: "https://mcp.linear.app/sse" },
    }),
    {
      fs: { command: "npx", args: ["-y", "x"], env: { A: "1" } },
      linear: { url: "https://mcp.linear.app/sse" },
    },
  );
});
