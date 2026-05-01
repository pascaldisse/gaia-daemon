#!/usr/bin/env node
import { GaiaApp } from "./app/gaia-app.js";
import { MemoryStore } from "./memory/memory-store.js";
import { globalAgentsPath, initWorkspace, loadWorkspace, workspacePath } from "./workspace/workspace-loader.js";

function usage(): void {
  console.log(`gaia — local-first multi-agent room\n\nUsage:\n  gaia          start the GAIA room in the current project\n  gaia init     create project room files and seed global personas\n  gaia --help   show help`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
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
    const workspace = await loadWorkspace(process.cwd());
    const memory = new MemoryStore();
    await new GaiaApp(process.cwd(), workspace, memory).start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gaia: ${message}`);
    console.error(`Expected project workspace: ${workspacePath(process.cwd())}`);
    console.error(`Global personas directory: ${globalAgentsPath()}`);
    console.error("Run `gaia init` in your project to prepare both layers.");
    process.exitCode = 1;
  }
}

await main();
