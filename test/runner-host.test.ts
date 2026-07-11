// RunnerHost against a STUB runner subprocess that speaks the wire protocol
// with no model behind it: streaming, model-label tracking, turn-error
// propagation, and the launch circuit breaker on crash-on-start. The host only
// ever reads spec DATA (capabilities, credentialProxy), so a stub harness spec
// stands in for the real adapters — no harness CLI is ever spawned.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDef, AgentEvent, Workspace } from "../src/core/types.js";
import { CircuitBreaker } from "../src/harness/breaker.js";
import { RunnerHost } from "../src/harness/host.js";
import { encodeFrame } from "../src/harness/protocol.js";
import { registerSandbox, type SandboxSpec } from "../src/harness/sandbox/spec.js";
import { registerHarness } from "../src/harness/spec.js";
import { createTempDir } from "./helpers/temp.js";

registerHarness({
  id: "stub",
  capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: true, supportsSteer: true },
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

// Same protocol double, but it declares sandboxPaths — the home-dir carves the
// host must thread into the sandbox launch as spec DATA (no id knowledge).
registerHarness({
  id: "stub-sandboxed",
  capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false, supportsCompact: false },
  ui: { label: "Stub (sandboxed)", description: "protocol test double with declared sandbox carves" },
  sandboxPaths: { writable: ["~/.stub-state"], readonly: ["~/.stub-state/auth.json"] },
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
    if (cmd.input.message === "hold") {
      // Stays open so the test can steer/inject mid-turn; a steer of "finish"
      // ends it (see the steer branch below).
      send({ type: "event", event: { type: "text-delta", delta: "held:start" } });
      return;
    }
    if (cmd.input.message === "stall") {
      // Reports an upstream stall then goes fully silent forever — the hard
      // stall deadline (STALL_ABORT_GRACE_MS) must fire, not the idle backstop.
      send({ type: "event", event: { type: "notice", kind: "upstream-stall", text: "gateway 502" } });
      return;
    }
    if (cmd.input.message === "stall-then-recover") {
      // Reports an upstream stall, then real output shortly after — proves
      // the deadline is cleared by recovery instead of firing regardless.
      send({ type: "event", event: { type: "notice", kind: "upstream-stall", text: "gateway 502" } });
      setTimeout(() => {
        send({ type: "event", event: { type: "text-delta", delta: "recovered" } });
        send({ type: "turn-end" });
      }, 50);
      return;
    }
    send({ type: "event", event: { type: "model-info", provider: "stub", modelId: "m", subscription: false } });
    send({ type: "event", event: { type: "text-delta", delta: "echo:" + cmd.input.message } });
    send({ type: "turn-end" });
  } else if (cmd.type === "steer") {
    if (cmd.message === "finish") {
      send({ type: "event", event: { type: "text-delta", delta: "post-steer" } });
      send({ type: "steer-result", ok: true });
      send({ type: "turn-end" });
    } else {
      send({ type: "steer-result", ok: true });
    }
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
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("injectEvent lands in the ACTIVE turn's stream at its current position; skipped when idle", async () => {
  const temp = await createTempDir();
  try {
    const host = await makeHost(temp.path);
    assert.equal(host.injectEvent({ type: "steered", eventId: "ev_too_early" }), false, "no active turn → marker skipped");

    const events: AgentEvent[] = [];
    for await (const event of host.send({ roomId: "default", message: "hold", transcript: [] })) {
      events.push(event);
      if (event.type === "text-delta" && event.delta === "held:start") {
        // The daemon-side steer flow: steer lands (round trip confirms the
        // runner is holding), THEN the marker is injected — it must surface in
        // the stream exactly here, before anything the turn streams later.
        assert.equal(await host.steer("default", "go left"), true);
        assert.equal(host.injectEvent({ type: "steered", eventId: "ev_steer" }), true);
        assert.equal(await host.steer("default", "finish"), true);
      }
    }

    assert.deepEqual(
      events.filter((e) => e.type === "steered" || e.type === "text-delta"),
      [
        { type: "text-delta", delta: "held:start" },
        { type: "steered", eventId: "ev_steer" },
        { type: "text-delta", delta: "post-steer" },
      ],
      "the marker sits exactly between the pre-steer and post-steer stream",
    );
    assert.equal(host.injectEvent({ type: "steered", eventId: "ev_too_late" }), false, "turn over → marker skipped");
    await host.dispose();
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
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost re-delivers a reset queued while the child was down, before the next turn (regression: edit/retry left the persisted session --resuming the ghost)", async () => {
  const temp = await createTempDir();
  try {
    // This stub records which rooms it has been told to reset, then reports on the
    // NEXT turn whether that room's reset arrived first. The real bug: a runner
    // idle-exits, edit/retry calls resetRoom on a down child, the old `if
    // (this.child)` guard dropped it, and because the harness session is persisted
    // on disk the next turn --resumed the whole rewound-away conversation.
    const RESET_STUB = `
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
send({ type: "ready", modelLabel: "stub/model" });
const wasReset = new Set();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line);
  if (cmd.type === "reset") wasReset.add(cmd.roomId);
  else if (cmd.type === "turn") {
    send({ type: "event", event: { type: "text-delta", delta: "reset-before-turn:" + (wasReset.has(cmd.input.roomId) ? "yes" : "no") } });
    send({ type: "turn-end" });
  } else if (cmd.type === "dispose") process.exit(0);
});
`;
    const stubPath = join(temp.path, "reset-stub.mjs");
    await writeFile(stubPath, RESET_STUB, "utf8");
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub",
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
    });
    // Reset with NO child alive (nothing spawned yet) — the exact idle-exited case.
    host.resetRoom("default");
    const events: AgentEvent[] = [];
    for await (const e of host.send({ roomId: "default", message: "hi", transcript: [] })) events.push(e);
    const echo = events.find((e) => e.type === "text-delta");
    assert.ok(echo && echo.type === "text-delta", "the turn must stream");
    assert.equal(echo.delta, "reset-before-turn:yes", "the queued reset must reach the fresh runner before the turn frame");
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost threads the spec's sandboxPaths (~ expanded) + governance carves into the sandbox launch", async () => {
  const temp = await createTempDir();
  try {
    let seen: SandboxSpec | undefined;
    registerSandbox({
      id: "spy-backend",
      available: () => true,
      wrap: (spec) => {
        seen = spec;
        return { command: spec.argv[0], args: spec.argv.slice(1) }; // passthrough: the stub runner still runs
      },
    });
    const stubPath = join(temp.path, "stub-runner.mjs");
    await writeFile(stubPath, STUB, "utf8");
    const agent = { ...AGENT, configPath: join(temp.path, "agents", "gaia", "agent.json") } as unknown as AgentDef;
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent,
      harness: "stub-sandboxed",
      allowSummon: () => true,
      sandbox: () => ({ enabled: true, backend: "spy-backend" }),
      runnerArgv: [process.execPath, stubPath],
    });
    for await (const _ of host.send({ roomId: "default", message: "hi", transcript: [] })) void _;
    assert.ok(seen, "the sandbox backend must wrap the launch");
    // The harness's declared carves arrive as data, `~` expanded by the host.
    assert.ok(seen.writable.includes(join(homedir(), ".stub-state")), "declared state dir is writable");
    assert.ok(seen.readonly.includes(join(homedir(), ".stub-state", "auth.json")), "declared credential store is carved read-only");
    // The governance carves ride along uniformly: workspace policy files + this
    // agent's OWN global agent.json (the trust bit) — a config-supplied writable
    // grant can never expose them (last match wins in the backend).
    assert.ok(seen.readonly.includes(join(temp.path, ".gaia", "config.json")), "workspace config stays read-only");
    assert.ok(seen.readonly.includes(join(temp.path, ".gaia", "agents")), "agents override dir stays read-only");
    assert.ok(seen.readonly.includes(agent.configPath), "the agent's own agent.json (trust bit) stays read-only");
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost forwards /compact over the wire and relays the harness's result", async () => {
  const temp = await createTempDir();
  try {
    const host = await makeHost(temp.path);
    // No child AND no durable session on disk → the uniform no-op (the shared
    // NO_SESSION_TO_COMPACT constant every harness returns too), no spawn.
    assert.deepEqual(await host.compact("default"), { compacted: false, message: "nothing to compact — no active session for this room." });
    for await (const _ of host.send({ roomId: "default", message: "hi", transcript: [] })) void _;
    // The runner's structured `compacted` flag rides through the wire.
    assert.deepEqual(await host.compact("default"), { compacted: true, message: "compacted default" });
    await host.dispose();
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
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost.dispose waits for a wedged runner to die after SIGTERM escalates", async () => {
  const temp = await createTempDir();
  try {
    const WEDGED_STUB = `
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.on("SIGTERM", () => {});
send({ type: "ready", modelLabel: "stub/model" });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line);
  if (cmd.type === "turn") {
    send({ type: "event", event: { type: "text-delta", delta: "alive" } });
    send({ type: "turn-end" });
  }
});
`;
    const stubPath = join(temp.path, "wedged-runner.mjs");
    await writeFile(stubPath, WEDGED_STUB, "utf8");
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub",
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
    });
    for await (const _ of host.send({ roomId: "default", message: "hi", transcript: [] })) void _;

    const started = Date.now();
    await host.dispose();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1500, `dispose returned before SIGKILL escalation (${elapsed}ms)`);
    assert.ok(elapsed < 3500, `dispose should resolve before the 3s cap plus slack (${elapsed}ms)`);
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
    await host.dispose();
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
    await host.dispose();
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
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost aborts a turn that goes fully silent past the idle backstop (regression: wedged CLI spun forever with no error)", async () => {
  const temp = await createTempDir();
  try {
    const stubPath = join(temp.path, "stub-runner.mjs");
    await writeFile(stubPath, STUB, "utf8");
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub",
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
      turnIdleTimeoutMs: 250,
    });
    // "hold" streams one delta then goes silent forever — the re-armed backstop
    // must fail the stream with the stall reason instead of hanging.
    const events: AgentEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of host.send({ roomId: "default", message: "hold", transcript: [] })) events.push(event);
      })(),
      /turn stalled — no output/,
    );
    assert.ok(
      events.some((e) => e.type === "text-delta" && e.delta === "held:start"),
      "progress streamed before the stall is preserved",
    );
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("RunnerHost's hard stall deadline aborts a turn that reports an upstream stall and never recovers", async () => {
  const temp = await createTempDir();
  try {
    const stubPath = join(temp.path, "stub-runner.mjs");
    await writeFile(stubPath, STUB, "utf8");
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub",
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      runnerArgv: [process.execPath, stubPath],
      stallAbortGraceMs: 100,
    });
    const events: AgentEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of host.send({ roomId: "default", message: "stall", transcript: [] })) events.push(event);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, "the turn must fail once the grace period elapses with no recovery");
    assert.equal((caught as Error).name, "UpstreamStallError");
    assert.match((caught as Error).message, /upstream stalled — no recovery/);
    assert.ok(events.some((e) => e.type === "notice" && e.kind === "upstream-stall"), "the notice itself still streamed before the deadline fired");
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});

test("a content frame after an upstream-stall notice clears the hard stall deadline — the turn completes normally", async () => {
  const temp = await createTempDir();
  try {
    const stubPath = join(temp.path, "stub-runner.mjs");
    await writeFile(stubPath, STUB, "utf8");
    const host = new RunnerHost({
      workspace: fakeWorkspace(temp.path),
      agent: AGENT,
      harness: "stub",
      allowSummon: () => true,
      sandbox: () => ({ enabled: false, backend: "none" }),
      // Grace is well past the stub's 50ms recovery delay, so a pass here
      // proves the content frame cleared the deadline — not that it merely
      // hadn't fired yet.
      stallAbortGraceMs: 400,
      runnerArgv: [process.execPath, stubPath],
    });
    const events: AgentEvent[] = [];
    for await (const event of host.send({ roomId: "default", message: "stall-then-recover", transcript: [] })) events.push(event);
    assert.ok(events.some((e) => e.type === "notice" && e.kind === "upstream-stall"));
    assert.ok(events.some((e) => e.type === "text-delta" && e.delta === "recovered"), "the turn ran to a normal, uninterrupted end");
    await host.dispose();
  } finally {
    await temp.cleanup();
  }
});
