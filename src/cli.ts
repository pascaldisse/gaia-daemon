#!/usr/bin/env node
import { existsSync } from "node:fs";
import { DEFAULT_CONFIG_PATH, ensureDefaultConfig, loadConfig, writeDefaultConfig } from "./config/config.js";
import { MemoryStore } from "./memory/memory-store.js";
import { GaiaApp } from "./app/gaia-app.js";

function usage(): void {
  console.log(`gaia — Pi SDK persona wrapper\n\nUsage:\n  gaia          start interactive GAIA\n  gaia init     create ~/.gaia/config.yaml and memory files\n  gaia --help   show help`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  if (args[0] === "init") {
    if (existsSync(DEFAULT_CONFIG_PATH)) {
      await ensureDefaultConfig();
      console.log(`Config already exists: ${DEFAULT_CONFIG_PATH}`);
    } else {
      await writeDefaultConfig();
      console.log(`Created ${DEFAULT_CONFIG_PATH}`);
    }
    const config = await loadConfig();
    const memory = new MemoryStore(config.memory.dir, {
      user: config.memory.userLimit,
      persona: config.memory.personaLimit,
    });
    await memory.init();
    console.log(`Memory directory ready: ${config.memory.dir}`);
    return;
  }

  if (args.length > 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    const config = await loadConfig();
    const memory = new MemoryStore(config.memory.dir, {
      user: config.memory.userLimit,
      persona: config.memory.personaLimit,
    });
    await new GaiaApp(process.cwd(), config, memory).start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gaia: ${message}`);
    console.error("Check Pi authentication/model configuration with `pi /login` or API-key environment variables.");
    process.exitCode = 1;
  }
}

await main();
