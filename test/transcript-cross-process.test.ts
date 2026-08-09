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

const ROOMS_MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "domain", "rooms.ts");
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

function run(fx: Fixture, op: string, arg: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fx.runner, fx.proj, ROOM_ID, op, arg], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function lines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim());
}

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
