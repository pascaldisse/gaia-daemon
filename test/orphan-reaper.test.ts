// Orphan reaping: pure selection (marker + not current daemon/current child) and
// the guarded reapOrphans driver via injected process-list / kill / sleep seams —
// no real `ps`, no real signals.

import test from "node:test";
import assert from "node:assert/strict";
import { installId, parsePsTable, selectOrphans, reapOrphans, INSTALL_MARKER_FLAG } from "../src/harness/reaper.js";

test("installId is deterministic per seed and differs across checkouts", () => {
  assert.equal(installId("/Users/a/.gaia"), installId("/Users/a/.gaia"));
  assert.notEqual(installId("/Users/a/.gaia"), installId("/Users/b/.gaia"));
  assert.match(installId("/x"), /^[0-9a-f]{12}$/);
});

test("parsePsTable keeps the command intact despite its inner spaces", () => {
  const raw = ["  123     1 node /p/cli.js __run-agent --gaia-install abc", " 7 7 /sbin/launchd", "garbage line"].join("\n");
  const entries = parsePsTable(raw);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { pid: 123, ppid: 1, command: "node /p/cli.js __run-agent --gaia-install abc" });
  assert.deepEqual(entries[1], { pid: 7, ppid: 7, command: "/sbin/launchd" });
});

const ID = "deadbeef0001";
const OTHER_ID = "feed0000ffff";
const mark = (s: string, id = ID) => `node cli.js __run-agent ${INSTALL_MARKER_FLAG} ${id} ${s}`;

test("selectOrphans selects marked processes with live non-self parents", () => {
  const entries = parsePsTable(
    [
      `  900 500 ${mark("runner-of-live-predecessor")}`,
      `  500 1 node cli.js serve`,
    ].join("\n"),
  );
  assert.deepEqual(selectOrphans(entries, ID, /*selfPid*/ 333), [900]);
});

test("selectOrphans excludes current daemon children", () => {
  const entries = parsePsTable(`  905 333 ${mark("my-own-live-child")}`);
  assert.deepEqual(selectOrphans(entries, ID, /*selfPid*/ 333), []);
});

test("selectOrphans excludes the current daemon pid", () => {
  const entries = parsePsTable(`  333 1 ${mark("the-daemon")}`);
  assert.deepEqual(selectOrphans(entries, ID, /*selfPid*/ 333), []);
});

test("selectOrphans excludes a different install id", () => {
  const entries = parsePsTable(`  903 1 ${mark("other-install", OTHER_ID)}`);
  assert.deepEqual(selectOrphans(entries, ID, /*selfPid*/ 333), []);
});

test("reapOrphans escalates SIGTERM survivors to SIGKILL", async () => {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const table = `  900 500 ${mark("stubborn")}`;
  const logs: string[] = [];
  const result = await reapOrphans({
    id: ID,
    selfPid: 333,
    listProcesses: () => table,
    kill: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => {},
    graceMs: 1,
    pollMs: 1,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(killed, [
    { pid: 900, signal: "SIGTERM" },
    { pid: 900, signal: "SIGKILL" },
  ]);
  assert.deepEqual(result, { found: 1, reaped: 0 });
  assert.match(logs.join("\n"), /SIGKILL needed for 1; SURVIVED 1/);
});

test("reapOrphans does not SIGKILL an orphan that disappears after SIGTERM", async () => {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let calls = 0;
  const result = await reapOrphans({
    id: ID,
    selfPid: 333,
    listProcesses: () => (++calls === 1 ? `  900 500 ${mark("gone-after-term")}` : ""),
    kill: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => {},
    graceMs: 1,
    pollMs: 1,
  });
  assert.deepEqual(killed, [{ pid: 900, signal: "SIGTERM" }]);
  assert.deepEqual(result, { found: 1, reaped: 1 });
});

test("reapOrphans treats same pid without marker after SIGTERM as gone", async () => {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let calls = 0;
  const result = await reapOrphans({
    id: ID,
    selfPid: 333,
    listProcesses: () => (++calls === 1 ? `  900 500 ${mark("reused")}` : "  900 500 node unrelated-process"),
    kill: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => {},
    graceMs: 1,
    pollMs: 1,
  });
  assert.deepEqual(killed, [{ pid: 900, signal: "SIGTERM" }]);
  assert.deepEqual(result, { found: 1, reaped: 1 });
});

test("reapOrphans is best-effort: a kill failure (already gone) doesn't abort the sweep", async () => {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let calls = 0;
  const result = await reapOrphans({
    id: ID,
    selfPid: 333,
    listProcesses: () => (++calls === 1 ? [`  900 1 ${mark("a")}`, `  901 1 ${mark("b")}`].join("\n") : `  901 1 ${mark("b")}`),
    kill: (pid, signal) => {
      if (pid === 900) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      killed.push({ pid, signal });
    },
    sleep: async () => {},
    graceMs: 1,
    pollMs: 1,
  });
  assert.deepEqual(killed, [
    { pid: 901, signal: "SIGTERM" },
    { pid: 901, signal: "SIGKILL" },
  ]);
  assert.equal(result.found, 2);
  assert.equal(result.reaped, 1);
});

test("reapOrphans swallows a ps failure and reaps nothing", async () => {
  const result = await reapOrphans({
    id: ID,
    listProcesses: () => {
      throw new Error("ps exploded");
    },
  });
  assert.deepEqual(result, { found: 0, reaped: 0 });
});
