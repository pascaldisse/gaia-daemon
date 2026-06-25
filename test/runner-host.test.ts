import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import "../src/runtime/index.ts"; // register harnesses (RunnerHost reads pi capabilities)
import { RunnerHost } from "../src/runtime/runner-host.ts";
import { CircuitBreaker } from "../src/runtime/circuit-breaker.ts";
import type { AgentEvent } from "../src/runtime/types.ts";
import { createTempDir } from "./helpers/temp.ts";

// A stub runner that speaks the protocol without a model: ready on start, and on
// each turn either streams a model-info + text-delta + turn-end, or a turn-error
// when the message is "boom".
const STUB = `
process.stdout.write(JSON.stringify({ type: "ready", modelLabel: "stub/model" }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "turn") {
      if (cmd.input.message === "boom") {
        process.stdout.write(JSON.stringify({ type: "turn-error", message: "stub failure" }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ type: "event", event: { type: "model-info", provider: "stub", modelId: "m", subscription: false } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "event", event: { type: "text-delta", delta: "hello" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn-end" }) + "\\n");
    } else if (cmd.type === "dispose") {
      process.exit(0);
    }
  }
});
`;

function fakeWorkspace(root: string): any {
  return { rootDir: root, roomsDir: join(root, "rooms"), config: {}, agents: {} };
}

const AGENT: any = { id: "gaia", memoryDir: join("/tmp", "mem"), model: { provider: "deepseek", name: "x" } };

async function makeHost(temp: string): Promise<RunnerHost> {
  const stubPath = join(temp, "stub-runner.mjs");
  await writeFile(stubPath, STUB, "utf8");
  return new RunnerHost({
    workspace: fakeWorkspace(temp),
    agent: AGENT,
    harness: "pi",
    sandbox: () => ({ enabled: false, backend: "none" }),
    runnerArgv: [process.execPath, stubPath],
  });
}

test("RunnerHost streams a turn's events and tracks the model label", async () => {
  const temp = await createTempDir();
  try {
    const host = await makeHost(temp.path);
    const events: AgentEvent[] = [];
    for await (const event of host.send({ roomId: "default", message: "hi", transcript: [] })) events.push(event);

    assert.ok(events.some((e) => e.type === "text-delta" && e.delta === "hello"));
    assert.ok(events.some((e) => e.type === "model-info"));
    assert.equal(host.modelLabel, "stub/m");
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});

// A runner that dies before ever reporting `ready` — a crash-on-start.
const CRASH_STUB = `process.exit(7);\n`;

test("RunnerHost trips the launch breaker on crash-on-start, then fast-fails", async () => {
  const temp = await createTempDir();
  try {
    const stubPath = join(temp.path, "crash-runner.mjs");
    await writeFile(stubPath, CRASH_STUB, "utf8");
    const breaker = new CircuitBreaker({ threshold: 1, cooldownScheduleMs: [60_000], resetMs: 3_600_000 });
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "pi",
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
      breaker,
    });

    // First turn: the child exits before `ready`, so the stream throws AND the
    // launch is recorded as a failure (threshold 1 → breaker trips open).
    await assert.rejects(async () => {
      for await (const _e of host.send({ roomId: "default", message: "hi", transcript: [] })) {
        // drain
      }
    });
    assert.equal(breaker.snapshot("pi:deepseek/x").state, "open");

    // Second turn fast-fails from the open breaker — no second spawn attempt.
    await assert.rejects(
      async () => {
        for await (const _e of host.send({ roomId: "default", message: "hi", transcript: [] })) {
          // drain
        }
      },
      /circuit open/i,
    );
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost surfaces a turn-error as a thrown stream", async () => {
  const temp = await createTempDir();
  try {
    const host = await makeHost(temp.path);
    await assert.rejects(async () => {
      for await (const _event of host.send({ roomId: "default", message: "boom", transcript: [] })) {
        // drain
      }
    }, /stub failure/);
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});
