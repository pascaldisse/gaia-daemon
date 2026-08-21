// GraphQL config surface: gaiaGraphqlEnabled/gaiaGraphqlPort precedence
// (env > .gaia/config.json `graphql` section > DEFAULTS) plus
// parseGraphqlConfig's tolerant parsing of that section.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS, gaiaGraphqlEnabled, gaiaGraphqlPort, parseGraphqlConfig } from "../src/core/config.js";
import { createTempDir } from "./helpers/temp.js";

async function writeConfig(cwd: string, config: unknown): Promise<void> {
  await mkdir(join(cwd, ".gaia"), { recursive: true });
  await writeFile(join(cwd, ".gaia", "config.json"), JSON.stringify(config), "utf8");
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("parseGraphqlConfig: enabled/port parse, junk drops, unknown extra fields drop silently", () => {
  assert.deepEqual(parseGraphqlConfig({ enabled: true, port: 5001 }), { enabled: true, port: 5001 });
  assert.deepEqual(parseGraphqlConfig({ enabled: true, extra: "ignored" }), { enabled: true });
  assert.deepEqual(parseGraphqlConfig({ port: 0 }), { port: 0 }); // 0 = pick a free port, still a valid explicit value
  assert.equal(parseGraphqlConfig({ port: 70000 }), undefined); // out of range drops
  assert.equal(parseGraphqlConfig({ port: "4780" }), undefined); // wrong type drops
  assert.equal(parseGraphqlConfig({ enabled: "true" }), undefined); // wrong type drops
  assert.equal(parseGraphqlConfig({}), undefined);
  assert.equal(parseGraphqlConfig(null), undefined);
  assert.equal(parseGraphqlConfig("nope"), undefined);
});

test("gaiaGraphqlEnabled/gaiaGraphqlPort: no env, no config file -> DEFAULTS", async () => {
  const temp = await createTempDir("gaia-graphql-cfg-");
  try {
    await withEnv({ GAIA_GRAPHQL_ENABLED: undefined, GAIA_GRAPHQL_PORT: undefined }, () => {
      assert.equal(gaiaGraphqlEnabled(temp.path), DEFAULTS.graphqlEnabled);
      assert.equal(gaiaGraphqlPort(temp.path), DEFAULTS.graphqlPort);
    });
  } finally {
    await temp.cleanup();
  }
});

test("gaiaGraphqlEnabled/gaiaGraphqlPort: config.json `graphql` section is the fallback", async () => {
  const temp = await createTempDir("gaia-graphql-cfg-");
  try {
    await writeConfig(temp.path, { graphql: { enabled: true, port: 5099 } });
    await withEnv({ GAIA_GRAPHQL_ENABLED: undefined, GAIA_GRAPHQL_PORT: undefined }, () => {
      assert.equal(gaiaGraphqlEnabled(temp.path), true);
      assert.equal(gaiaGraphqlPort(temp.path), 5099);
    });
  } finally {
    await temp.cleanup();
  }
});

test("gaiaGraphqlEnabled/gaiaGraphqlPort: env override wins over config.json fallback", async () => {
  const temp = await createTempDir("gaia-graphql-cfg-");
  try {
    await writeConfig(temp.path, { graphql: { enabled: true, port: 5099 } });
    await withEnv({ GAIA_GRAPHQL_ENABLED: "false", GAIA_GRAPHQL_PORT: "6001" }, () => {
      assert.equal(gaiaGraphqlEnabled(temp.path), false);
      assert.equal(gaiaGraphqlPort(temp.path), 6001);
    });
  } finally {
    await temp.cleanup();
  }
});

test("gaiaGraphqlEnabled/gaiaGraphqlPort: partial config.json section (enabled only) leaves port at DEFAULTS", async () => {
  const temp = await createTempDir("gaia-graphql-cfg-");
  try {
    await writeConfig(temp.path, { graphql: { enabled: true } });
    await withEnv({ GAIA_GRAPHQL_ENABLED: undefined, GAIA_GRAPHQL_PORT: undefined }, () => {
      assert.equal(gaiaGraphqlEnabled(temp.path), true);
      assert.equal(gaiaGraphqlPort(temp.path), DEFAULTS.graphqlPort);
    });
  } finally {
    await temp.cleanup();
  }
});

test("gaiaGraphqlEnabled/gaiaGraphqlPort: missing .gaia/config.json entirely -> DEFAULTS, no throw", async () => {
  const temp = await createTempDir("gaia-graphql-cfg-");
  try {
    await withEnv({ GAIA_GRAPHQL_ENABLED: undefined, GAIA_GRAPHQL_PORT: undefined }, () => {
      assert.equal(gaiaGraphqlEnabled(temp.path), DEFAULTS.graphqlEnabled);
      assert.equal(gaiaGraphqlPort(temp.path), DEFAULTS.graphqlPort);
    });
  } finally {
    await temp.cleanup();
  }
});
