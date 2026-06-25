// Orphan reaping: pure selection (marker + dead parent, never self or a live
// sibling daemon's children) and the guarded reapOrphans driver via injected
// process-list / kill seams — no real `ps`, no real signals.

import test from "node:test";
import assert from "node:assert/strict";
import { installId, parsePsTable, selectOrphans, reapOrphans, INSTALL_MARKER_FLAG } from "../src/runtime/orphan-reaper.ts";

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
const mark = (s: string) => `node cli.js __run-agent ${INSTALL_MARKER_FLAG} ${ID} ${s}`;

test("selectOrphans reaps only this install's marked, parent-dead processes", () => {
  const entries = parsePsTable(
    [
      `  900 1 ${mark("orphan-reparented-to-init")}`, // ppid 1 → reap
      `  901 4242 ${mark("orphan-parent-gone")}`, // ppid not in table → reap
      `  902 500 ${mark("child-of-live-sibling-daemon")}`, // ppid 500 alive → keep
      `  500 1 node cli.js serve`, // a live (sibling) daemon
      `  903 1 node cli.js __run-agent ${INSTALL_MARKER_FLAG} feed0000ffff other-install`, // other checkout → keep
      `  904 1 /usr/bin/unrelated`, // unmarked → keep
    ].join("\n"),
  );
  const orphans = selectOrphans(entries, ID, /*selfPid*/ 333);
  assert.deepEqual(orphans.sort((a, b) => a - b), [900, 901]);
});

test("selectOrphans never targets the daemon itself or its own children", () => {
  const self = 333;
  const entries = parsePsTable([`  ${self} 1 ${mark("the-daemon")}`, `  905 ${self} ${mark("my-own-live-child")}`].join("\n"));
  assert.deepEqual(selectOrphans(entries, ID, self), []);
});

test("reapOrphans signals each selected orphan and reports the count", () => {
  const killed: number[] = [];
  const table = [`  900 1 ${mark("a")}`, `  901 1 ${mark("b")}`, `  902 7 node cli.js serve`].join("\n");
  const logs: string[] = [];
  const result = reapOrphans({ id: ID, selfPid: 333, listProcesses: () => table, kill: (pid) => killed.push(pid), log: (m) => logs.push(m) });
  assert.deepEqual(killed.sort((a, b) => a - b), [900, 901]);
  assert.deepEqual(result, { found: 2, reaped: 2 });
  assert.match(logs.join("\n"), /reaped 2\/2/);
});

test("reapOrphans is best-effort: a kill failure (already gone) doesn't abort the sweep", () => {
  const killed: number[] = [];
  const table = [`  900 1 ${mark("a")}`, `  901 1 ${mark("b")}`].join("\n");
  const result = reapOrphans({
    id: ID,
    selfPid: 333,
    listProcesses: () => table,
    kill: (pid) => {
      if (pid === 900) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      killed.push(pid);
    },
  });
  assert.deepEqual(killed, [901]);
  assert.equal(result.found, 2);
  assert.equal(result.reaped, 1);
});

test("reapOrphans swallows a ps failure and reaps nothing", () => {
  const result = reapOrphans({
    id: ID,
    listProcesses: () => {
      throw new Error("ps exploded");
    },
  });
  assert.deepEqual(result, { found: 0, reaped: 0 });
});
