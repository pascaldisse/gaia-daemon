// Run: bun test test/transcript-writer-race.ts
// Child mode invokes the production RoomHandle; no production code is changed.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { RoomHandle } from "../src/domain/rooms.js";
import { workspacePaths } from "../src/core/paths.js";

const child = process.argv[2];
let root = process.argv[3];
const roomId = "race";

async function handle(): Promise<RoomHandle> {
  return RoomHandle.open(root!, roomId);
}

async function lines(path: string): Promise<Array<{ id: string; text?: string }>> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

if (child === "append") {
  const room = await handle();
  const id = process.argv[4]!;
  await room.appendEvent({ id, timestamp: "t", author: "gaia", text: id });
  process.exit(0);
}
if (child === "commit") {
  const id = process.argv[4]!;
  await (await handle()).commitTurn({ id, timestamp: "t", author: "gaia", text: id });
  process.exit(0);
}
if (child === "rewind") {
  await (await handle()).rewindTranscript(1);
  process.exit(0);
}
if (child === "redact") {
  await (await handle()).redactEvents(new Map([["seed-0", "redacted"]]));
  process.exit(0);
}
if (child === "clear") {
  await (await handle()).clearTranscript();
  process.exit(0);
}
if (child === "fork-copy") {
  await cp(workspacePaths.transcript(root!, roomId), join(root!, "fork.jsonl"));
  process.exit(0);
}
if (child === "hold-state-lock") {
  const { withSqliteImmediateLock } = await import("../src/core/sqlite.js");
  await withSqliteImmediateLock(`${workspacePaths.roomState(root!, roomId)}.lock.sqlite`, async () => {
    process.kill(process.pid, "SIGSTOP");
  });
  process.exit(0);
}

async function spawn(mode: string, ...args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, import.meta.path, mode, root!, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

async function prepare(count = 25000): Promise<void> {
  await rm(root!, { recursive: true, force: true });
  await mkdir(root!, { recursive: true });
  const room = await handle();
  const events = Array.from({ length: count }, (_, i) => JSON.stringify({ id: `seed-${i}`, timestamp: "t", author: "user", targets: ["gaia"], text: `seed-${i}` })).join("\n") + "\n";
  await writeFile(room.transcriptPath, events);
}

async function appendMany(prefix: string, n = 16, sameId = false, mode = "append"): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => sameId ? prefix : `${prefix}-${i}`);
  const result = await Promise.all(ids.map((id) => spawn(mode, id)));
  expect(result).toEqual(Array.from({ length: n }, () => ({ exitCode: 0, stderr: "" })));
  return ids;
}

const runRoot = join(process.cwd(), ".gaia", `transcript-race-${process.pid}`);

describe("cross-process transcript counterexamples", () => {
  test("16 same-id appenders produce 16 duplicate JSONL records", async () => {
    root = runRoot;
    await prepare(0);
    const ids = await appendMany("same", 16, true, "commit");
    const got = await lines(workspacePaths.transcript(root, roomId));
    console.log(`same-id: requested=${ids.length} matching=${got.filter((event) => event.id === "same").length} total=${got.length}`);
    expect(got.filter((event) => event.id === "same")).toHaveLength(16);
  }, 30_000);

  test("16 distinct appenders retain all records", async () => {
    root = runRoot;
    await prepare(0);
    const ids = await appendMany("distinct", 16);
    const got = await lines(workspacePaths.transcript(root, roomId));
    console.log(`distinct-id: requested=${ids.length} present=${ids.filter((id) => got.some((event) => event.id === id)).length} total=${got.length}`);
    expect(new Set(got.map((event) => event.id))).toEqual(new Set(ids));
  }, 30_000);

  for (const mode of ["rewind", "redact", "clear"] as const) {
    test(`${mode} read/rewrite can discard concurrent append`, async () => {
      root = runRoot;
      await prepare();
      const rewrite = spawn(mode);
      const ids = await appendMany(mode, 64);
      await rewrite;
      const got = await lines(workspacePaths.transcript(root, roomId));
      const missing = ids.filter((id) => !got.some((event) => event.id === id));
      console.log(`${mode}: requested=${ids.length} present=${ids.length - missing.length} missing=${missing.length} ids=${missing.join(",")}`);
      if (mode !== "clear") expect(missing.length).toBeGreaterThan(0);
      // clear is a one-syscall truncate; this run can serialize before every
      // append. It remains uncoordinated, but loss is deliberately not claimed
      // unless the raw output above reports it.
    }, 60_000);
  }

  test("fork copy is a snapshot during concurrent append", async () => {
    root = runRoot;
    await prepare();
    const copy = spawn("fork-copy");
    const ids = await appendMany("fork", 64);
    await copy;
    const copied = await lines(join(root, "fork.jsonl"));
    const live = await lines(workspacePaths.transcript(root, roomId));
    const copiedNew = ids.filter((id) => copied.some((event) => event.id === id)).length;
    console.log(`fork-copy: copied-new=${copiedNew}/64 copied-lines=${copied.length} live-new=${ids.filter((id) => live.some((event) => event.id === id)).length}`);
    expect(copied.every((event) => event.id)).toBe(true);
  }, 60_000);

  test("SIGKILL lock owner releases SQLite immediate lock", async () => {
    root = runRoot;
    await prepare(0);
    const owner = Bun.spawn([process.execPath, import.meta.path, "hold-state-lock", root], { stdout: "ignore", stderr: "pipe" });
    await Bun.sleep(200);
    owner.kill("SIGKILL");
    await owner.exited;
    const result = await spawn("append", "after-kill");
    console.log(`lock-kill: owner=${owner.exitCode} append=${result.exitCode} stderr=${JSON.stringify(result.stderr)}`);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
