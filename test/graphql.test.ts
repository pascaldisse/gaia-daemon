// Real HTTP surface for the /graphql test surface: boots the standalone
// GraphQL server (src/server/graphql.ts) on an ephemeral localhost port and
// drives it with plain `fetch`, exactly like a browser hitting GraphiQL would
// — no daemon restart, no mocked transport.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { scaffoldGlobalAgent } from "../src/domain/agents.js";
import { globalAgentsPath } from "../src/domain/workspace.js";
import { startGraphqlServer, type GraphqlServer } from "../src/server/graphql.js";
import { createTempDir } from "./helpers/temp.js";

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function post<T>(base: string, query: string, variables?: Record<string, unknown>): Promise<{ status: number; body: GraphqlResponse<T> }> {
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: (await response.json()) as GraphqlResponse<T> };
}

test("live GraphQL surface: GraphiQL IDE loads over HTTP, mem query reads a real agent memory file, generic verb mutation excludes bash", async () => {
  const temp = await createTempDir("gaia-graphql-");
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "gaia-home");
  let server: GraphqlServer | undefined;
  try {
    // Real fixture: a real global agent, scaffolded through the same code path
    // scaffoldGlobalAgent/loadAgentDefinitions use in production — not a stub.
    const scaffold = await scaffoldGlobalAgent(globalAgentsPath(), "testagent", { displayName: "Test Agent" });
    assert.ok(scaffold.memoryDir);

    server = await startGraphqlServer({ cwd: temp.path, port: 0 });
    const base = server.url;

    // 1) GraphiQL IDE is reachable over plain HTTP (the "test webapp").
    const ide = await fetch(base, { headers: { accept: "text/html" } });
    assert.equal(ide.status, 200);
    const html = await ide.text();
    assert.match(html, /GraphiQL/);

    // 2) A real executed query over HTTP: mem(agentId) reads the freshly
    // scaffolded agent's real MEMORY.md off disk.
    const memResult = await post<{ mem: { content: string; files: unknown } }>(
      base,
      "query Mem($agentId: String!) { mem(agentId: $agentId) { content files { file } } }",
      { agentId: "testagent" },
    );
    assert.equal(memResult.status, 200);
    assert.equal(memResult.body.errors, undefined);
    assert.match(memResult.body.data!.mem.content, /# Test Agent Memory/);

    // list:true switches to the file listing instead of one file's content.
    const listResult = await post<{ mem: { content: string | null; files: Array<{ file: string }> } }>(
      base,
      "query MemList($agentId: String!) { mem(agentId: $agentId, list: true) { content files { file } } }",
      { agentId: "testagent" },
    );
    assert.equal(listResult.body.errors, undefined);
    assert.equal(listResult.body.data!.mem.content, null);
    assert.ok(listResult.body.data!.mem.files.some((f) => f.file === "MEMORY.md"));

    // Unknown agent -> a typed GraphQL error, not a crash.
    const unknownAgent = await post<{ mem: unknown }>(base, 'query { mem(agentId: "no-such-agent") { content } }');
    assert.ok(unknownAgent.body.errors?.length);
    assert.match(unknownAgent.body.errors![0].message, /unknown agent/);

    // 3) Generic verb() escape hatch: caryll works (local file op, no network);
    // bash is permanently rejected (security).
    const fixturePath = join(temp.path, "caryll-fixture.txt");
    await Bun.write(fixturePath, "hello ".repeat(200));
    const caryllResult = await post<{ verb: string }>(
      base,
      "mutation Verb($verb: String!, $argsJson: String!) { verb(verb: $verb, argsJson: $argsJson) }",
      { verb: "caryll", argsJson: JSON.stringify({ action: "stats", path: fixturePath }) },
    );
    assert.equal(caryllResult.body.errors, undefined);
    const stats = JSON.parse(caryllResult.body.data!.verb) as { tokensBefore: number; tokensAfter: number };
    assert.ok(stats.tokensBefore > 0);

    const bashResult = await post<{ verb: string }>(
      base,
      "mutation Verb($verb: String!, $argsJson: String!) { verb(verb: $verb, argsJson: $argsJson) }",
      { verb: "bash", argsJson: "{}" },
    );
    assert.ok(bashResult.body.errors?.length);
    assert.match(bashResult.body.errors![0].message, /excluded/);
  } finally {
    if (server) await server.close();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
});
