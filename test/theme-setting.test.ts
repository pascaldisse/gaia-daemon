// services/theme.ts — the UI palette as a daemon setting (v2 parity). The one
// risk in a read-merge-write against ~/.gaia/app.json is clobbering the other
// keys that live there (keepAwake, userName, recentWorkspaces), so that is
// what this pins, plus the "" = clear contract.

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";

let home = "";
let previous: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gaia-theme-"));
  previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.GAIA_HOME;
  else process.env.GAIA_HOME = previous;
});

async function theme(): Promise<typeof import("../src/services/theme.js")> {
  return import("../src/services/theme.js");
}

test("unset theme reads as empty string", async () => {
  const { readThemeSetting } = await theme();
  assert.equal(await readThemeSetting(), "");
});

test("write/read round-trips and preserves the other app.json keys", async () => {
  const { readThemeSetting, writeThemeSetting } = await theme();
  const file = join(home, "app.json");
  await writeFile(file, JSON.stringify({ keepAwake: true, userName: "pascal", recentWorkspaces: ["/tmp/ws"] }), "utf8");

  await writeThemeSetting("kanagawa");
  assert.equal(await readThemeSetting(), "kanagawa");

  const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(config.keepAwake, true);
  assert.equal(config.userName, "pascal");
  assert.deepEqual(config.recentWorkspaces, ["/tmp/ws"]);
});

test("empty id clears the setting rather than storing an empty palette", async () => {
  const { readThemeSetting, writeThemeSetting } = await theme();
  await writeThemeSetting("dracula");
  await writeThemeSetting("   ");
  assert.equal(await readThemeSetting(), "");
  const config = JSON.parse(await readFile(join(home, "app.json"), "utf8")) as Record<string, unknown>;
  assert.equal("theme" in config, false);
});
