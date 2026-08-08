import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHooksConfig } from "../src/core/config.js";
import { runHooks } from "../src/services/hooks.js";

test("parseHooksConfig: string shorthand, objects, unknown events drop", () => {
  const hooks = parseHooksConfig({
    postTurn: ["notify-send done", { command: "slack-post", timeoutSec: 30 }, { command: "" }, 42],
    error: [{ command: "alert" }],
    nonsense: ["x"],
    preTurn: [],
  });
  assert.deepEqual(hooks, {
    postTurn: [{ command: "notify-send done" }, { command: "slack-post", timeoutSec: 30 }],
    error: [{ command: "alert" }],
  });
  assert.equal(parseHooksConfig(undefined), undefined);
  assert.equal(parseHooksConfig({}), undefined);
});

test("runHooks delivers the payload on stdin with GAIA_HOOK_* env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-hooks-"));
  const out = join(dir, "out.json");
  await runHooks(
    [{ command: `cat > ${out}.body; printf '%s %s %s' "$GAIA_HOOK_EVENT" "$GAIA_ROOM_ID" "$GAIA_AGENT_ID" > ${out}.env` }],
    "postTurn",
    { roomId: "default", agentId: "gaia", reply: "done", outcome: "complete" },
    { cwd: dir },
  );
  const body = JSON.parse(await readFile(`${out}.body`, "utf8"));
  assert.equal(body.event, "postTurn");
  assert.equal(body.reply, "done");
  assert.equal(await readFile(`${out}.env`, "utf8"), "postTurn default gaia");
});

test("runHooks logs failures and never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-hooks-"));
  const logs: string[] = [];
  await runHooks(
    [{ command: "echo boom >&2; exit 3" }, { command: "true" }],
    "error",
    { roomId: "default" },
    { cwd: dir, log: (message) => logs.push(message) },
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /exited 3/);
  assert.match(logs[0], /boom/);
});

test("runHooks kills a hook past its timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-hooks-"));
  const logs: string[] = [];
  const started = Date.now();
  await runHooks([{ command: "sleep 30", timeoutSec: 0.2 }], "preTurn", { roomId: "default" }, { cwd: dir, log: (m) => logs.push(m) });
  assert.ok(Date.now() - started < 5_000, "did not wait for the sleep");
  assert.match(logs[0] ?? "", /timed out/);
});
