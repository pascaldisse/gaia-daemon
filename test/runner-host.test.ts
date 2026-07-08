// RunnerHost against a STUB runner subprocess that speaks the wire protocol
// with no model behind it: streaming, model-label tracking, turn-error
// propagation, and the launch circuit breaker on crash-on-start. The host only
// ever reads spec DATA (capabilities, credentialProxy), so a stub harness spec
// stands in for the real adapters — no harness CLI is ever spawned.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDef, AgentEvent, Workspace } from "../src/core/types.js";
import { CircuitBreaker } from "../src/harness/breaker.js";
import { RunnerHost } from "../src/harness/host.js";
import { encodeFrame } from "../src/harness/protocol.js";
import { registerHarness } from "../src/harness/spec.js";
import { createTempDir } from "./helpers/temp.js";

registerHarness({
  id: "stub",
  capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true },
  ui: { label: "Stub", description: "protocol test double" },
  // No durable session on disk → a cold /compact has nothing to resume.
  hasDurableSession: () => false,
  create: () => {
    throw new Error("not used: the runner subprocess is stubbed");
  },
});

// Same protocol double, but it reports a durable on-disk session — so a cold
// /compact (no child yet) must spawn the runner and compact the persisted handle.
registerHarness({
  id: "stub-durable",
  capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true },
  ui: { label: "Stub (durable)", description: "protocol test double with a persisted session" },
  hasDurableSession: () => true,
  create: () => {
    throw new Error("not used: the runner subprocess is stubbed");
  },
});

// A stub runner that speaks the protocol without a model: ready on start, and on
// each turn either streams a model-info + text-delta + turn-end, or a turn-error
// when the message is "boom".
// Reads stdin through readline exactly like the real runner (runner.ts) — that
// is the layer the U+2028 frame-split regression lives in — and writes frames
// through the same escaping contract (encodeFrame's replace, inlined).
const STUB = `
import { createInterface } from "node:readline";
const esc = (o) => JSON.stringify(o).replace(/\\u2028/g, "\\\\u2028").replace(/\\u2029/g, "\\\\u2029");
const send = (o) => process.stdout.write(esc(o) + "\\n");
send({ type: "ready", modelLabel: "stub/model" });
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    send({ type: "turn-error", message: "stub received unparseable frame" });
    return;
  }
  if (cmd.type === "turn") {
    if (cmd.input.message === "boom") {
      send({ type: "turn-error", message: "stub failure" });
      return;
    }
    send({ type: "event", event: { type: "model-info", provider: "stub", modelId: "m", subscription: false } });
    send({ type: "event", event: { type: "text-delta", delta: "echo:" + cmd.input.message } });
    send({ type: "turn-end" });
  } else if (cmd.type === "compact") {
    send({ type: "compact-result", ok: true, compacted: true, message: "compacted " + cmd.roomId });
  } else if (cmd.type === "dispose") {
    process.exit(0);
  }
});
`;

function fakeWorkspace(root: string): Workspace {
  return {
    rootDir: root,
    roomsDir: join(root, "rooms"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    config: {},
    agents: {},
  } as unknown as Workspace;
}

const AGENT = { id: "gaia", memoryDir: join("/tmp", "mem"), model: { provider: "deepseek", name: "x" } } as unknown as AgentDef;

async function makeHost(temp: string): Promise<RunnerHost> {
  const stubPath = join(temp, "stub-runner.mjs");
  await writeFile(stubPath, STUB, "utf8");
  return new RunnerHost({
    workspace: fakeWorkspace(temp),
    agent: AGENT,
    harness: "stub",
    allowSummon: () => true,
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

    assert.ok(events.some((e) => e.type === "text-delta" && e.delta === "echo:hi"));
    assert.ok(events.some((e) => e.type === "model-info"));
    assert.equal(host.modelLabel, "stub/m");
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("encodeFrame: U+2028/U+2029 in content never reach the wire raw", () => {
  const frame = { type: "turn", input: { roomId: "r", message: "a\u2028b\u2029c", transcript: [] } } as Parameters<typeof encodeFrame>[0];
  const wire = encodeFrame(frame);
  assert.ok(!wire.includes("\u2028") && !wire.includes("\u2029"), "raw line separators must be escaped");
  // Value-identical after parse — escaping changes bytes, never meaning.
  assert.deepEqual(JSON.parse(wire), JSON.parse(JSON.stringify(frame)));
});

test("a turn whose content contains U+2028 survives the wire round trip (regression: frame split by readline)", async () => {
  const temp = await createTempDir();
  try {
    const host = await makeHost(temp.path);
    // The Sidia-block paste that wedged a real room: raw LINE SEPARATOR chars
    // inside a transcript event and the message itself.
    const poison = "spirit animal: fractal\u2028violet\u2029safeword: violet melancholy\u2028end";
    const events: AgentEvent[] = [];
    for await (const event of host.send({
      roomId: "default",
      message: poison,
      transcript: [{ id: "e1", timestamp: "2026-07-04T00:00:00.000Z", author: "user", text: poison }],
    })) {
      events.push(event);
    }
    const echo = events.find((e) => e.type === "text-delta");
    assert.ok(echo && echo.type === "text-delta", "turn must stream back instead of wedging");
    assert.equal(echo.delta, `echo:${poison}`, "content must arrive intact, separators included");
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost forwards /compact over the wire and relays the harness's result", async () => {
  const temp = await createTempDir();
  try {
    const host = await makeHost(temp.path);
    // No child AND no durable session on disk → nothing to compact, no spawn.
    assert.deepEqual(await host.compact("default"), { compacted: false, message: "nothing to compact — no active session yet." });
    for await (const _ of host.send({ roomId: "default", message: "hi", transcript: [] })) void _;
    // The runner's structured `compacted` flag rides through the wire.
    assert.deepEqual(await host.compact("default"), { compacted: true, message: "compacted default" });
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost /compact cold-spawns the runner when a durable session exists (no prior turn)", async () => {
  const temp = await createTempDir();
  try {
    const stubPath = join(temp.path, "stub-runner.mjs");
    await writeFile(stubPath, STUB, "utf8");
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub-durable", // reports a persisted session
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
    });
    // No turn has run this process-lifetime, but the harness has a durable
    // session — /compact must spawn the runner and resume it, not bail.
    assert.deepEqual(await host.compact("default"), { compacted: true, message: "compacted default" });
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
      harness: "stub",
      allowSummon: () => true,
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
    assert.equal(breaker.snapshot("stub:deepseek/x").state, "open");

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

test("RunnerHost fails a mid-turn child death and a fresh turn respawns cleanly", async () => {
  const temp = await createTempDir();
  try {
    // Dies AFTER ready, mid-turn — a runtime death, not a launch failure: the
    // active stream must throw, but the breaker stays closed so the next turn
    // simply respawns.
    const DIE_MID_TURN = `
process.stdout.write(JSON.stringify({ type: "ready", modelLabel: "stub/model" }) + "\\n");
process.stdin.on("data", () => process.exit(3));
`;
    const stubPath = join(temp.path, "die-mid-turn.mjs");
    await writeFile(stubPath, DIE_MID_TURN, "utf8");
    const breaker = new CircuitBreaker({ threshold: 1, cooldownScheduleMs: [60_000], resetMs: 3_600_000 });
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub",
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
      breaker,
    });

    await assert.rejects(async () => {
      for await (const _e of host.send({ roomId: "default", message: "hi", transcript: [] })) {
        // drain
      }
    }, /agent runner exited/);
    // ready arrived before the death → the LAUNCH succeeded; breaker closed.
    assert.equal(breaker.snapshot("stub:deepseek/x").state, "closed");
    host.dispose();
  } finally {
    await temp.cleanup();
  }
});
