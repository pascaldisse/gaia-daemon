#!/usr/bin/env node
// The one entrypoint. Lightweight subcommands (mem/recall/summon, init, agent
// create) never pull in the web-server graph — heavy modules load lazily.

import { scaffoldGlobalAgent } from "./domain/agents.js";
import { globalAgentsPath, initWorkspace } from "./domain/workspace.js";

function usage(): void {
  console.log(
    `gaia — local-first multi-agent room\n\nUsage:\n  gaia                         start the GAIA web UI\n  gaia init                    create project room files and seed global personas\n  gaia agent create <id> [name] create a global agent persona scaffold\n  gaia setup list|activate|status|off   load a saved multi-agent setup into a room\n  gaia serve <room> [--port N] [--adapter id]   serve a monad room as one model\n  gaia mem|recall|summon …     agent memory/recall/summon (used inside a turn)\n  gaia --dev                   enable local development reload hooks\n  gaia --help                  show help`,
  );
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Hidden: the shared confinement entrypoint. Parsed from rawArgs so flags
  // meant for the CHILD (after `--`) are never touched by the --dev filter.
  if (rawArgs[0] === "__sandbox-exec") {
    const { runSandboxExec } = await import("./harness/sandbox/cli.js");
    process.exitCode = await runSandboxExec(rawArgs.slice(1));
    return;
  }

  const devMode = rawArgs.includes("--dev");
  const args = rawArgs.filter((arg) => arg !== "--dev");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  // Hidden: the per-(room, agent) runner subprocess the daemon spawns for
  // every harness. Long-lived; speaks the runner protocol over stdio.
  if (args[0] === "__run-agent") {
    const { runAgentRunner } = await import("./harness/runner.js");
    await runAgentRunner();
    return;
  }

  if (args[0] === "mem" || args[0] === "memory" || args[0] === "recall" || args[0] === "summon") {
    const { runHarnessCommand } = await import("./services/cli-tools.js");
    process.exitCode = await runHarnessCommand(args);
    return;
  }

  if (args[0] === "setup") {
    const { runSetupCli } = await import("./services/setups.js");
    process.exitCode = await runSetupCli(args.slice(1));
    return;
  }

  if (args[0] === "serve") {
    const { runServeCli } = await import("./services/setups.js");
    process.exitCode = await runServeCli(args.slice(1));
    return;
  }

  if (args[0] === "agent" && args[1] === "create") {
    const id = args[2];
    const displayName = args.slice(3).join(" ").trim() || undefined;
    if (!id) {
      console.error("Usage: gaia agent create <id> [display name]");
      process.exitCode = 1;
      return;
    }
    try {
      const result = await scaffoldGlobalAgent(globalAgentsPath(), id, { displayName });
      console.log(`Agent created: ${result.agentDir}`);
      console.log(`Config: ${result.configPath}`);
      console.log(`Soul: ${result.soulPath}`);
      console.log(`Memory: ${result.memoryDir}`);
      console.log(`Roles: ${result.rolesDir}`);
    } catch (error) {
      console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "init") {
    const result = await initWorkspace(process.cwd());
    console.log(`Project workspace ready: ${result.workspaceDir}`);
    console.log(`Global personas ready: ${result.globalAgentsDir}`);
    return;
  }

  if (args.length > 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    // Register every harness + sandbox backend + routing policy exactly once,
    // then start the server.
    await import("./harness/index.js");
    await import("./services/policies/index.js");
    const { startWebServer } = await import("./server/http.js");
    const server = await startWebServer({ cwd: process.cwd(), dev: devMode });
    console.log(`GAIA web UI: ${server.url}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.close().finally(resolve);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
