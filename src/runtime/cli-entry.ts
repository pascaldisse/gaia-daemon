// Shared CLI-entry resolution for the runtime helpers that re-launch THIS
// daemon's CLI (the runner host's `gaia __run-agent` subprocess and Claude's
// `gaia` shim). The entry is cli.js when built, cli.ts under tsx (dev/no-build);
// assuming a built cli.js sibling broke `gaia` whenever the daemon ran via tsx,
// so we pick whichever exists. These take no harness as input — pure resolution
// (AGENTS.md §RULE #0).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to this install's CLI entry: cli.js when built, else cli.ts
 * (dev/tsx). Resolved relative to the runtime directory.
 */
export function resolveCliEntry(): string {
  const jsPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(jsPath) ? jsPath : fileURLToPath(new URL("../cli.ts", import.meta.url));
}

/**
 * The argv prefix that re-launches THIS daemon exactly how it was launched:
 * execPath plus the node flags in execArgv (which under tsx carry the TS loader,
 * e.g. `--import …/tsx/loader.mjs`), followed by the resolved CLI entry. So a
 * plain re-launch works in both built mode (`node cli.js`) and dev/tsx mode
 * (`node --import tsx … cli.ts`).
 */
export function selfRelaunchArgv(): string[] {
  return [process.execPath, ...process.execArgv, resolveCliEntry()];
}
