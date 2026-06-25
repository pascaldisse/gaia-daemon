#!/usr/bin/env node
import { scaffoldGlobalAgent } from "./agents/scaffold.js";
import { runHarnessCommand } from "./cli-harness.js";
import { globalAgentsPath, initWorkspace } from "./workspace/workspace-loader.js";

function usage(): void {
  console.log(`gaia — local-first multi-agent room\n\nUsage:\n  gaia                         start the GAIA web UI\n  gaia init                    create project room files and seed global personas\n  gaia agent create <id> [name] create a global agent persona scaffold\n  gaia setup list|activate|status|off   load a saved multi-agent setup into a room\n  gaia serve <room> [--port N] [--adapter id]   serve a monad room as one model\n  gaia mem|recall|summon …     agent memory/recall/summon (used inside a turn)\n  gaia --dev                   enable local development reload hooks\n  gaia --help                  show help`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Hidden: the shared confinement entrypoint. `gaia __sandbox-exec … -- argv`
  // runs the child argv inside the SAME sandbox the daemon uses (one source of
  // truth; the pi skill and any future harness call this instead of rolling
  // their own profile). Parsed from rawArgs so flags meant for the CHILD (after
  // `--`) are never touched — not even by the --dev filter below.
  if (rawArgs[0] === "__sandbox-exec") {
    const { runSandboxExec } = await import("./runtime/sandbox/exec-cli.js");
    process.exitCode = await runSandboxExec(rawArgs.slice(1));
    return;
  }

  const devMode = rawArgs.includes("--dev");
  const args = rawArgs.filter((arg) => arg !== "--dev");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  // Hidden: the per-(room, agent) runner subprocess the daemon spawns for every
  // harness. Long-lived; talks the runner protocol over stdio (see RunnerHost).
  if (args[0] === "__run-agent") {
    const { runAgentRunner } = await import("./runtime/agent-runner.js");
    await runAgentRunner();
    return;
  }

  if (args[0] === "mem" || args[0] === "memory" || args[0] === "recall" || args[0] === "summon") {
    process.exitCode = await runHarnessCommand(args);
    return;
  }

  if (args[0] === "setup") {
    const { runSetupCli } = await import("./setups/setup-cli.js");
    process.exitCode = await runSetupCli(args.slice(1));
    return;
  }

  if (args[0] === "serve") {
    const { runServeCli } = await import("./setups/serve-cli.js");
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
      return;
    } catch (error) {
      console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
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
    // Imported lazily so lightweight subcommands (mem/recall/summon, init,
    // agent create) don't pull in the web server graph (and node:sqlite).
    const { startWebServer } = await import("./web/server.js");
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gaia: ${message}`);
    process.exitCode = 1;
  }
}

await main();
