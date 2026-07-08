// The agent-runner subprocess (`gaia __run-agent`). The daemon spawns exactly
// this for EVERY harness (see host.ts) — Pi included, no longer privileged
// in-process — so execution is uniform and the sandbox has one process to wrap.
// It builds the real runtime via the harness registry (its translation code
// untouched) with bridge-backed deps, then runs a single-flight loop: read a
// command on stdin, stream the turn's AgentEvents back on stdout as protocol
// JSON.
//
// stdout carries ONLY protocol lines, so every console.* is redirected to
// stderr (the daemon forwards stderr to its own logs).

import { createInterface } from "node:readline";
import { env } from "../core/env.js";
import { loadWorkspace } from "../domain/workspace.js";
import { BridgeMemoryStore, bridgeRecallSearch, bridgeSummonCreate, fixedTokenHost } from "./bridge-deps.js";
// Self-register every harness before the lookup — this subprocess starts with
// an empty registry.
import "./index.js";
import { encodeFrame, RUNNER_ENV, type RunnerCommand, type RunnerMessage } from "./protocol.js";
import { type AgentRuntime, harnessIdFor, harnessSpecFor } from "./spec.js";

function send(message: RunnerMessage): void {
  process.stdout.write(`${encodeFrame(message)}\n`);
}

export async function runAgentRunner(): Promise<void> {
  // Keep stdout pristine for the protocol; everything else goes to stderr.
  console.log = (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`);
  console.info = console.log;
  console.warn = (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`);

  const workspacePath = env(RUNNER_ENV.workspacePath);
  const agentId = env(RUNNER_ENV.agentId);
  if (!workspacePath || !agentId) {
    send({ type: "turn-error", message: "runner missing workspace/agent env" });
    process.exit(1);
  }

  const workspace = await loadWorkspace(workspacePath);
  const agent = workspace.agents[agentId];
  if (!agent) {
    send({ type: "turn-error", message: `runner unknown agent: ${agentId}` });
    process.exit(1);
  }

  // Bridge target (daemon url + token) is present whenever the daemon has a
  // harness bridge. memory reads are disk; writes + summon go to the daemon.
  const url = env(RUNNER_ENV.daemonUrl);
  const token = env(RUNNER_ENV.daemonToken);
  const target = url && token ? { url, token } : undefined;

  const memoryStore = target ? new BridgeMemoryStore(target) : new BridgeMemoryStore({ url: "", token: "" });
  const summonCreate = target ? bridgeSummonCreate(target) : undefined;
  const harnessHost = target ? fixedTokenHost(target) : undefined;

  // The daemon already resolved the harness (agent > workspace > default) and
  // passed it down; fall back to recomputing if the env is somehow absent.
  const harness = env(RUNNER_ENV.harness) ?? harnessIdFor(agent, workspace);
  const runtime: AgentRuntime = harnessSpecFor(harness).create({
    workspace,
    agent,
    memoryStore,
    summonCreate,
    harnessHost,
    recallSearch: target ? bridgeRecallSearch(target) : undefined,
  });

  send({ type: "ready", modelLabel: runtime.modelLabel });

  let turnActive = false;

  const runTurn = async (input: Parameters<AgentRuntime["send"]>[0]): Promise<void> => {
    turnActive = true;
    try {
      for await (const event of runtime.send(input)) send({ type: "event", event });
      send({ type: "model-label", modelLabel: runtime.modelLabel });
      send({ type: "turn-end" });
    } catch (error) {
      send({ type: "turn-error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      turnActive = false;
    }
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let command: RunnerCommand;
    try {
      command = JSON.parse(trimmed) as RunnerCommand;
    } catch {
      // A frame that doesn't parse means the wire is corrupted — if it was a
      // turn, the daemon is now waiting on a reply that will never come.
      // turn-error unblocks it either way (harmless if no turn was in flight).
      process.stderr.write(`runner: dropped unparseable frame (${trimmed.length} bytes): ${trimmed.slice(0, 80)}\n`);
      send({ type: "turn-error", message: "runner received an unparseable protocol frame — turn dropped" });
      return;
    }
    switch (command.type) {
      case "turn":
        // Single-flight: a turn arriving while one is active means daemon and
        // runner disagree about state. Failing fast beats a silent drop — the
        // daemon would otherwise wait on this turn forever.
        if (turnActive) send({ type: "turn-error", message: "runner busy — a turn is already active" });
        else void runTurn(command.input);
        return;
      case "abort":
        void runtime.abort();
        return;
      case "steer":
        void (runtime.steer?.(command.roomId, command.message) ?? Promise.resolve(false))
          .catch(() => false)
          .then((ok) => send({ type: "steer-result", ok }));
        return;
      case "compact":
        void (
          runtime.compact?.(command.roomId, (update) => send({ type: "compact-progress", ...update })) ??
          Promise.reject(new Error("compaction not supported"))
        )
          .then((result) => send({ type: "compact-result", ok: true, compacted: result.compacted, message: result.message }))
          .catch((error: unknown) =>
            send({ type: "compact-result", ok: false, compacted: false, message: error instanceof Error ? error.message : String(error) }),
          );
        return;
      case "reset":
        runtime.resetRoom(command.roomId);
        return;
      case "dispose":
        runtime.dispose();
        rl.close();
        process.exit(0);
    }
  });

  // Daemon closed our stdin (killed us / shut down): dispose and exit.
  rl.on("close", () => {
    runtime.dispose();
    process.exit(0);
  });
}
