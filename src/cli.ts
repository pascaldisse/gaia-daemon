#!/usr/bin/env node
import { GaiaApp } from "./app/gaia-app.js";
import { MemoryStore } from "./memory/memory-store.js";
import { initWorkspace, loadWorkspace, workspacePath } from "./workspace/workspace-loader.js";

function usage(): void {
  console.log(`gaia — local-first multi-agent workspace\n\nUsage:\n  gaia          start the GAIA room in the current project\n  gaia init     create .gaia workspace files in the current project\n  gaia --help   show help`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  if (args[0] === "init") {
    const dir = await initWorkspace(process.cwd());
    console.log(`Workspace ready: ${dir}`);
    return;
  }

  if (args.length > 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    const workspace = await loadWorkspace(process.cwd());
    const memory = new MemoryStore();
    await new GaiaApp(process.cwd(), workspace, memory).start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gaia: ${message}`);
    console.error(`Expected workspace: ${workspacePath(process.cwd())}`);
    console.error("Run `gaia init` in your project to create the workspace.");
    process.exitCode = 1;
  }
}

await main();
