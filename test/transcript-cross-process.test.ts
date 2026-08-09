// transcript-cross-process — falsification tests for transcript.jsonl writers
// running in SEPARATE OS processes. The daemon is not the only writer: CLI
// invocations, summon lanes and `gaia __run-agent` children all open the same
// room. In-process promise chains coordinate none of that, so every claim here
// is made with real `bun` child processes; mocks would test the mock.
//
// Falsified without the room lock:
//   (b) two processes replaying one reserved event id -> two committed lines
//   (c) a full rewrite (redact) racing appends -> lost or torn lines
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { RoomHandle } from "../src/domain/rooms.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { workspacePaths } from "../src/core/paths.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOMS_MODULE = join(REPO, "src", "domain", "rooms.ts");
const SQLITE_MODULE = join(REPO, "src", "core", "sqlite.ts");
const IMPORT_SCRIPT = join(REPO, "scripts", "import-claude-export.ts");
const ROOM_ID = "default";

interface Fixture {
  proj: string;
  runner: string;
  transcript: string;
  cleanup(): Promise<void>;
}

/** A child that opens the room through the real RoomHandle and performs one
 * writer operation, then exits — one process per writer, as in production. */
const RUNNER = `
import { RoomHandle } from ${JSON.stringify(ROOMS_MODULE)};
import { withSqliteImmediateLock } from ${JSON.stringify(SQLITE_MODULE)};

const [proj, roomId, op, arg] = process.argv.slice(2);
const room = await RoomHandle.open(proj, roomId);
if (op === "commit") {
  await room.commitTurn({ id: arg, timestamp: new Date().toISOString(), author: "agent", text: "reply " + arg });
} else if (op === "append") {
  await room.appendEvent({ id: arg, timestamp: new Date().toISOString(), author: "user", targets: [], text: "msg " + arg });
} else if (op === "redact") {
  await room.redactEvents(new Map([[arg, "REDACTED"]]));
} else if (op === "rewind") {
  await room.rewindTranscript(Number(arg));
} else if (op === "clear") {
  await room.clearRoom();
} else if (op === "fork") {
  const snapshot = await room.snapshotTranscript();
  const target = await RoomHandle.open(proj, arg);
  if (!(await target.seedTranscript(snapshot))) process.exitCode = 17;
} else if (op === "hold-lock") {
  await withSqliteImmediateLock(room.statePath + ".lock.sqlite", async () => {
    console.log("locked");
    await new Promise(() => {});
  });
} else {
  throw new Error("unknown op " + op);
}
`;

async function fixture(prefix: string): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const prevHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  await mkdir(proj, { recursive: true });
  await initWorkspace(proj);
  await RoomHandle.open(proj, ROOM_ID);
  const runner = join(tmp, "runner.mjs");
  await writeFile(runner, RUNNER, "utf8");
  return {
    proj,
    runner,
    transcript: workspacePaths.transcript(proj, ROOM_ID),
    cleanup: async () => {
      if (prevHome === undefined) delete process.env.GAIA_HOME;
      else process.env.GAIA_HOME = prevHome;
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

function childExit(child: ReturnType<typeof spawn>): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? -1, signal }));
  });
}

function start(fx: Fixture, op: string, arg: string, stdout: "ignore" | "pipe" = "ignore") {
  return spawn(process.execPath, [fx.runner, fx.proj, ROOM_ID, op, arg], {
    stdio: ["ignore", stdout, "inherit"],
    env: { ...process.env },
  });
}

async function run(fx: Fixture, op: string, arg: string): Promise<number> {
  return (await childExit(start(fx, op, arg))).code;
}

async function waitForStdout(child: ReturnType<typeof spawn>, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => reject(new Error(`child exited before ${text}: ${code}/${signal}`)));
  });
}

async function lines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim());
}

// (g) SQLite's OS lock is released when its owning process is killed: a
// successor does not wait for the killed owner's five-second acquisition budget.
test("(g) SIGKILL lock owner releases append successor", async () => {
  const fx = await fixture("gaia-xproc-kill-lock-");
  try {
    const owner = start(fx, "hold-lock", "", "pipe");
    await waitForStdout(owner, "locked");
    owner.kill("SIGKILL");
    assert.equal((await childExit(owner)).signal, "SIGKILL");

    assert.equal(await run(fx, "append", "after-killed-owner"), 0);
    assert.equal((JSON.parse((await lines(fx.transcript)).at(-1)!) as { id: string }).id, "after-killed-owner");
  } finally {
    await fx.cleanup();
  }
});

// (b) append-once: the WAL reserves one event id; a replay in another process
// must NOT produce a second copy of the committed reply.
test("(b) 16 processes committing one reserved event id write exactly one line", async () => {
  const fx = await fixture("gaia-xproc-b-");
  try {
    const codes = await Promise.all(Array.from({ length: 16 }, () => run(fx, "commit", "evt-shared")));
    assert.deepEqual([...new Set(codes)], [0], `all writers must succeed, got exit codes ${codes.join(",")}`);

    const written = await lines(fx.transcript);
    for (const line of written) JSON.parse(line); // no torn line
    assert.equal(written.length, 1, `duplicate committed reply: ${written.length} lines for one reserved id`);
  } finally {
    await fx.cleanup();
  }
});

// (b') distinct ids: coordination must not swallow real events either.
test("(b) 16 processes committing distinct ids write 16 valid lines", async () => {
  const fx = await fixture("gaia-xproc-b2-");
  try {
    const ids = Array.from({ length: 16 }, (_, i) => `evt-${i}`);
    const codes = await Promise.all(ids.map((id) => run(fx, "commit", id)));
    assert.deepEqual([...new Set(codes)], [0], `all writers must succeed, got exit codes ${codes.join(",")}`);

    const written = await lines(fx.transcript);
    const parsed = written.map((line) => JSON.parse(line) as { id: string });
    assert.equal(parsed.length, 16, "an append was lost");
    assert.deepEqual(new Set(parsed.map((event) => event.id)), new Set(ids));
  } finally {
    await fx.cleanup();
  }
});

/** Live transcript ids ∪ archived ids: the invariant every rewrite must keep
 * — an event may leave the conversation, never disk. */
async function survivingIds(fx: Fixture): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of ["transcript.jsonl", "rewound.jsonl", "redactions.jsonl"]) {
    for (const line of await lines(join(fx.transcript, "..", name))) ids.add((JSON.parse(line) as { id: string }).id);
  }
  return ids;
}

/** Seed `count` user events through the real writer. */
async function seed(fx: Fixture, count: number, prefix: string): Promise<string[]> {
  const room = await RoomHandle.open(fx.proj, ROOM_ID);
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
  for (const id of ids) {
    await room.appendEvent({ id, timestamp: new Date().toISOString(), author: "user", targets: [], text: `seed ${id}` });
  }
  return ids;
}

// (c) a full-file rewrite (read -> archive -> publish) racing appends from
// other processes: nothing may be torn, and no pre-existing event may vanish.
test("(c) redact racing 8 appending processes loses no committed event", async () => {
  const fx = await fixture("gaia-xproc-c-");
  try {
    const room = await RoomHandle.open(fx.proj, ROOM_ID);
    const seeded = Array.from({ length: 12 }, (_, i) => `seed-${i}`);
    for (const id of seeded) {
      await room.appendEvent({ id, timestamp: new Date().toISOString(), author: "user", targets: [], text: `seed ${id}` });
    }

    const appends = Array.from({ length: 8 }, (_, i) => run(fx, "append", `late-${i}`));
    const redacts = seeded.slice(0, 4).map((id) => run(fx, "redact", id));
    const codes = await Promise.all([...appends, ...redacts]);
    assert.deepEqual([...new Set(codes)], [0], `all writers must succeed, got exit codes ${codes.join(",")}`);

    const written = await lines(fx.transcript);
    const parsed = written.map((line) => JSON.parse(line) as { id: string }); // throws on a torn line
    const ids = new Set(parsed.map((event) => event.id));
    for (const id of seeded) assert.ok(ids.has(id), `rewrite destroyed committed event ${id}`);
    for (let i = 0; i < 8; i++) assert.ok(ids.has(`late-${i}`), `rewrite swallowed concurrent append late-${i}`);
  } finally {
    await fx.cleanup();
  }
});

// (c) Kali's reproduction, rewind flavour: 64 appends from other processes
// while one process rewinds. Unlocked, 8 of 64 vanished from BOTH the live
// file and rewound.jsonl — deleted, not archived.
test("(c) rewind racing 64 appending processes deletes nothing", async () => {
  const fx = await fixture("gaia-xproc-rewind-");
  try {
    await seed(fx, 4, "base");
    const ids = Array.from({ length: 64 }, (_, i) => `race-${i}`);
    const codes = await Promise.all([...ids.map((id) => run(fx, "append", id)), run(fx, "rewind", "2")]);
    assert.deepEqual([...new Set(codes)], [0], `all writers must succeed, got exit codes ${codes.join(",")}`);

    const surviving = await survivingIds(fx);
    const missing = ids.filter((id) => !surviving.has(id));
    assert.deepEqual(missing, [], `${missing.length}/64 appended events destroyed by the rewind`);
  } finally {
    await fx.cleanup();
  }
});

// (c) same, redact flavour: an in-place rewrite is the widest window (it
// republishes every line), so a lost append here is the loudest signal.
test("(c) redact racing 64 appending processes deletes nothing", async () => {
  const fx = await fixture("gaia-xproc-redact-");
  try {
    const [target] = await seed(fx, 1, "base");
    const ids = Array.from({ length: 64 }, (_, i) => `race-${i}`);
    const codes = await Promise.all([...ids.map((id) => run(fx, "append", id)), run(fx, "redact", target)]);
    assert.deepEqual([...new Set(codes)], [0], `all writers must succeed, got exit codes ${codes.join(",")}`);

    const surviving = await survivingIds(fx);
    const missing = ids.filter((id) => !surviving.has(id));
    assert.deepEqual(missing, [], `${missing.length}/64 appended events destroyed by the redact`);
  } finally {
    await fx.cleanup();
  }
});

// (c) /clear is a rewrite too: what it wipes must be archived, and appends
// racing it must not disappear without a trace.
test("(c) clear racing 32 appending processes archives everything it wipes", async () => {
  const fx = await fixture("gaia-xproc-clear-");
  try {
    const base = await seed(fx, 8, "base");
    const ids = Array.from({ length: 32 }, (_, i) => `race-${i}`);
    const codes = await Promise.all([...ids.map((id) => run(fx, "append", id)), run(fx, "clear", "")]);
    assert.deepEqual([...new Set(codes)], [0], `all writers must succeed, got exit codes ${codes.join(",")}`);

    const surviving = await survivingIds(fx);
    const missing = [...base, ...ids].filter((id) => !surviving.has(id));
    assert.deepEqual(missing, [], `${missing.length} events destroyed by /clear`);
  } finally {
    await fx.cleanup();
  }
});

// (1) A transcript whose last line has no terminator is committed history —
// legacy line or torn tail. The next append separates itself from it instead
// of gluing on, and neither repairs nor deletes the existing bytes.
test("(1) append to an unterminated transcript inserts a separator, keeps the bytes", async () => {
  const fx = await fixture("gaia-xproc-tail-");
  try {
    const torn = `{"id":"torn","timestamp":"t","author":"user","targets":[],"te`;
    await writeFile(fx.transcript, torn, "utf8");
    assert.equal(await run(fx, "append", "after-torn"), 0);

    const text = await readFile(fx.transcript, "utf8");
    assert.ok(text.startsWith(torn), "damaged bytes were repaired or truncated — history must be preserved as-is");
    const written = await lines(fx.transcript);
    assert.equal(written.length, 2, "the new event was glued onto the unterminated tail");
    assert.equal((JSON.parse(written[1]) as { id: string }).id, "after-torn");
  } finally {
    await fx.cleanup();
  }
});

// (2) This invokes the real importer, rather than calling replaceTranscript
// directly. Every racing append must survive either in its new live transcript
// or in the import's rewound archive.
test("(2) import --force racing appends keeps every append live or archived", async () => {
  const fx = await fixture("gaia-xproc-force-import-");
  try {
    await seed(fx, 4, "before-import");
    const exportDir = join(fx.proj, "claude-export");
    await mkdir(exportDir);
    await writeFile(join(exportDir, "conversations.json"), JSON.stringify([{
      uuid: "import-chat",
      name: "imported",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:01.000Z",
      chat_messages: [{ uuid: "import-message", sender: "human", created_at: "2026-01-01T00:00:00.000Z", text: "from export" }],
    }]), "utf8");
    const importer = spawn(process.execPath, [IMPORT_SCRIPT, "--export", exportDir, "--workspace", fx.proj, "--agent", "importer", "--room", ROOM_ID, "--force"], {
      stdio: ["ignore", "ignore", "inherit"], env: { ...process.env },
    });
    const ids = Array.from({ length: 32 }, (_, i) => `during-force-${i}`);
    const result = await Promise.all([childExit(importer), ...ids.map((id) => run(fx, "append", id))]);
    assert.equal(result[0].code, 0, `import failed: ${JSON.stringify(result[0])}`);
    assert.ok(result.slice(1).every((code) => code === 0), `append exit codes: ${result.slice(1).join(",")}`);
    const surviving = await survivingIds(fx);
    assert.deepEqual(ids.filter((id) => !surviving.has(id)), [], "--force import erased a concurrent append");
  } finally {
    await fx.cleanup();
  }
});

// (3) commitTurn's child is SIGKILLed only after its new transcript record is
// observable. The large valid prelude holds it in the cursor scan between the
// fsynced append and the following state write; this is a real process crash,
// not a mocked filesystem or state writer. It proves that a crash there leaves
// durable transcript history while pendingTurn remains resumable. Power-loss
// persistence past the kernel/fsync contract remains intentionally unprovable.
// (2') Two independently-invoked /forks take a locked source snapshot and
// exclusive-create separate targets. A target collision is a clean failure:
// it may not mutate either source or occupied destination.
test("(2') concurrent forks preserve source, seed both targets, and refuse an occupied target", async () => {
  const fx = await fixture("gaia-xproc-fork-");
  try {
    const sourceIds = await seed(fx, 8, "source");
    const sourceBefore = await readFile(fx.transcript, "utf8");
    assert.deepEqual(await Promise.all([run(fx, "fork", "branch-a"), run(fx, "fork", "branch-b")]), [0, 0]);
    for (const target of ["branch-a", "branch-b"]) {
      const copied = await readFile(workspacePaths.transcript(fx.proj, target), "utf8");
      assert.equal(copied, sourceBefore, `${target} is not the source snapshot`);
      const targetRoom = await RoomHandle.open(fx.proj, target);
      assert.deepEqual((await targetRoom.eventsFrom(0)).events.map((event) => event.id), sourceIds);
    }
    assert.equal(await readFile(fx.transcript, "utf8"), sourceBefore, "fork mutated source history");

    const occupied = await RoomHandle.open(fx.proj, "occupied");
    await occupied.appendEvent({ id: "occupied-only", timestamp: "t", author: "user", targets: [], text: "keep" });
    const occupiedBefore = await readFile(occupied.transcriptPath, "utf8");
    const [freshCode, occupiedCode] = await Promise.all([run(fx, "fork", "branch-c"), run(fx, "fork", "occupied")]);
    assert.equal(freshCode, 0, "concurrent successful fork failed beside occupied target");
    assert.equal(occupiedCode, 17, "occupied target did not report exclusive-create failure");
    assert.equal(await readFile(workspacePaths.transcript(fx.proj, "branch-c"), "utf8"), sourceBefore, "successful peer fork has wrong seed");
    assert.equal(await readFile(occupied.transcriptPath, "utf8"), occupiedBefore, "failed fork clobbered target");
    assert.equal(await readFile(fx.transcript, "utf8"), sourceBefore, "failed fork mutated source");
  } finally {
    await fx.cleanup();
  }
});

// (2'') Two real --force import processes serialize their archive+replace
// critical sections. Every pre-import/imported record remains live or archived;
// rewound.jsonl stays parseable under the concurrent archive writers.
test("(2'') concurrent --force imports preserve both imported histories and archive", async () => {
  const fx = await fixture("gaia-xproc-double-force-import-");
  try {
    const before = await seed(fx, 4, "before");
    const exports = await Promise.all(["left", "right"].map(async (side) => {
      const dir = join(fx.proj, `export-${side}`);
      await mkdir(dir);
      await writeFile(join(dir, "conversations.json"), JSON.stringify([{
        uuid: `chat-${side}`, name: side, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
        chat_messages: [{ uuid: `message-${side}`, sender: "human", created_at: "2026-01-01T00:00:00.000Z", text: side }],
      }]), "utf8");
      return dir;
    }));
    const exits = await Promise.all(exports.map((dir) => childExit(spawn(process.execPath, [IMPORT_SCRIPT, "--export", dir, "--workspace", fx.proj, "--agent", "importer", "--room", ROOM_ID, "--force"], {
      stdio: ["ignore", "ignore", "inherit"], env: { ...process.env },
    }))));
    assert.ok(exits.every((exit) => exit.code === 0), `import exits: ${JSON.stringify(exits)}`);
    const all = await survivingIds(fx);
    assert.deepEqual(before.filter((id) => !all.has(id)), [], "concurrent import erased pre-existing event");
    const records = (await Promise.all([fx.transcript, join(fx.transcript, "..", "rewound.jsonl")].map(lines))).flat().map((line) => JSON.parse(line) as { id: string; text: string });
    for (const text of ["left", "right"]) assert.ok(records.some((record) => record.text === text), `imported event missing: ${text}`);
    assert.ok(all.size >= before.length + 2, "live/archive did not retain both imports");
  } finally {
    await fx.cleanup();
  }
});

// (2''') Structural writers are one room-lock domain: clearing twice archives
// only the first snapshot; clear/rewind archive disjoint snapshots (or one is a
// no-op). Neither schedule may lose or duplicate an original event.
test("(2''') concurrent clear/clear and clear/rewind retain each original once", async () => {
  for (const [label, ops] of [["clear-clear", ["clear", "clear"]], ["clear-rewind", ["clear", "rewind"]]] as const) {
    const fx = await fixture(`gaia-xproc-${label}-`);
    try {
      const ids = await seed(fx, 8, label);
      const codes = await Promise.all(ops.map((op) => run(fx, op, op === "rewind" ? "1" : "")));
      assert.deepEqual([...new Set(codes)], [0], `${label} exit codes: ${codes.join(",")}`);
      const locations = [fx.transcript, join(fx.transcript, "..", "rewound.jsonl")];
      const recorded = (await Promise.all(locations.map(lines))).flat().map((line) => (JSON.parse(line) as { id: string }).id);
      for (const id of ids) assert.equal(recorded.filter((candidate) => candidate === id).length, 1, `${label}: ${id} missing or doubly archived`);
    } finally {
      await fx.cleanup();
    }
  }
});

// (3) commitTurn's child is SIGKILLed only after its new transcript record is
// observable. The large valid prelude holds it in the cursor scan between the
// fsynced append and the following state write; this is a real process crash,
// not a mocked filesystem or state writer. It proves that a crash there leaves
// durable transcript history while pendingTurn remains resumable. Power-loss
// persistence past the kernel/fsync contract remains intentionally unprovable.
test("(3) WAL transcript is observable before commitTurn state acknowledgement", async () => {
  const fx = await fixture("gaia-xproc-wal-order-");
  try {
    const room = await RoomHandle.open(fx.proj, ROOM_ID);
    const eventId = "wal-before-state";
    await room.markPendingTurn({ id: "wal-task", eventId, prompt: "p", targets: ["agent"], agentId: "agent", partialReply: "", startedAt: "now" });
    const prelude = Array.from({ length: 50_000 }, (_, i) => JSON.stringify({ id: `prelude-${i}`, timestamp: "t", author: "user", targets: [], text: "p" })).join("\n") + "\n";
    await writeFile(fx.transcript, prelude, "utf8");

    const committer = start(fx, "commit", eventId);
    let observed = false;
    for (let tries = 0; tries < 100; tries++) {
      if ((await readFile(fx.transcript, "utf8")).includes(`"id":"${eventId}"`)) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(observed, "the child never made its WAL record observable");
    committer.kill("SIGKILL");
    assert.equal((await childExit(committer)).signal, "SIGKILL");

    assert.ok((await readFile(fx.transcript, "utf8")).includes(`"id":"${eventId}"`), "SIGKILL lost the observable WAL record");
    assert.equal((await room.state()).pendingTurn?.eventId, eventId, "state acknowledgement happened before the crash window");
  } finally {
    await fx.cleanup();
  }
});

// (h) The exported core primitive must keep "1 record = 1 JSON line" even for
// callers OUTSIDE the room lock: separator newline and record used to go out
// as TWO writes, so a concurrent O_APPEND writer could land between them and
// glue/blank-split a record. One write closes that. What remains — and cannot
// be closed without a lock — is several writers concurrently observing the
// same unterminated legacy tail and each emitting its own separator: that
// produces at most one blank line per racing writer, in the recovery case
// only, and a blank line is skipped identically by every reader (it never
// splits or hides a record). Real processes, no mocks.
test("(h) 64 processes appending through appendJsonlDurable write only whole records", { timeout: 60_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gaia-xproc-append-"));
  try {
    const path = join(tmp, "log.jsonl");
    // Start from a file whose last byte is NOT a newline: the branch that used
    // to emit a separate separator write.
    await writeFile(path, '{"id":"legacy-no-terminator"}', "utf8");
    const runner = join(tmp, "append.mjs");
    await writeFile(
      runner,
      `import { appendJsonlDurable } from ${JSON.stringify(join(REPO, "src", "core", "store.ts"))};
await appendJsonlDurable(process.argv[2], { id: process.argv[3], text: "x".repeat(200) });
`,
      "utf8",
    );
    // Attach the exit listener at spawn time: a child that exits before its
    // promise is created would otherwise never be observed.
    const exits = Array.from({ length: 64 }, (_, i) =>
      childExit(spawn(process.execPath, [runner, path, `w${i}`], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env } })),
    );
    for (const exit of exits) assert.equal((await exit).code, 0);

    const body = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
    for (const line of body) JSON.parse(line); // throws on a torn or glued record
    const ids = body.map((line) => (JSON.parse(line) as { id: string }).id);
    assert.equal(new Set(ids).size, ids.length, "a record was duplicated or glued onto another");
    assert.equal(ids.length, 65, `expected 65 whole records, got ${ids.length}`);
    for (let i = 0; i < 64; i++) assert.ok(ids.includes(`w${i}`), `record w${i} was lost`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
