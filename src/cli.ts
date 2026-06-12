#!/usr/bin/env node
import { scaffoldGlobalAgent } from "./agents/scaffold.js";
import { startWebServer } from "./web/server.js";
import { globalAgentsPath, initWorkspace } from "./workspace/workspace-loader.js";

function usage(): void {
  console.log(`gaia — local-first multi-agent room\n\nUsage:\n  gaia                         start the GAIA web UI\n  gaia init                    create project room files and seed global personas\n  gaia agent create <id> [name] create a global agent persona scaffold\n  gaia --dev                   enable local development reload hooks\n  gaia --help                  show help`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const devMode = rawArgs.includes("--dev");
  const args = rawArgs.filter((arg) => arg !== "--dev");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
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
      console.log(`Memory: ${result.memoryPath}`);
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
