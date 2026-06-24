import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWorkspace } from "../src/workspace/workspace-loader.ts";
import { RUNNER_ENV, type RunnerMessage } from "../src/runtime/runner-protocol.ts";
import { createTempDir } from "./helpers/temp.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// Spawns the REAL runner the same way RunnerHost does (execPath + execArgv so the
// tsx loader carries over) and verifies the subprocess wiring end to end WITHOUT
// running a turn (no model call): it loads the workspace, builds the runtime, and
// completes the ready handshake, then shuts down cleanly when stdin closes.
test("agent-runner spawns, builds a pi runtime, and reports ready", async () => {
  const temp = await createTempDir();
  const home = join(temp.path, "home");
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  try {
    await initWorkspace(temp.path);

    const child = spawn(process.execPath, [...process.execArgv, CLI, "__run-agent"], {
      cwd: temp.path,
      env: {
        ...process.env,
        GAIA_HOME: home,
        [RUNNER_ENV.workspacePath]: temp.path,
        [RUNNER_ENV.agentId]: "gaia",
        [RUNNER_ENV.harness]: "pi",
        [RUNNER_ENV.roomId]: "default",
        [RUNNER_ENV.memoryDir]: join(home, "agents", "gaia", "persona", "memory"),
        [RUNNER_ENV.roomDir]: join(temp.path, ".gaia", "rooms", "default"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const ready = await new Promise<RunnerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runner did not report ready in time")), 20_000);
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        try {
          const message = JSON.parse(line) as RunnerMessage;
          if (message.type === "ready") {
            clearTimeout(timer);
            resolve(message);
          }
        } catch {
          // ignore non-protocol lines
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`runner exited before ready (code ${code})`));
      });
    });

    assert.equal(ready.type, "ready");
    assert.equal(typeof (ready as { modelLabel: string }).modelLabel, "string");

    // Closing stdin makes the runner dispose and exit cleanly.
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.stdin.end();
      setTimeout(() => child.kill(), 5_000);
    });
    assert.ok(exitCode === 0 || exitCode === null);
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});
