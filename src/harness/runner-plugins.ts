// Runner-side plugin loader. A runner plugin is a single .mjs file dropped in
// ~/.gaia/plugins/runner/ that hooks the agent runner subprocess at boot,
// BEFORE any harness runtime is built. Loaded uniformly for every harness
// (RULE #0): the seam knows nothing about which harness runs, nor what any
// plugin does. Mirrors the ~/.gaia/plugins/*.mjs command-plugin loader
// (see services/plugins.ts) but for the runner process instead of the daemon.
//
// Contract: a plugin's default export (or the module itself) may expose
// `wrapFetch(next)` returning a replacement fetch. Plugins compose in filename
// order onto globalThis.fetch — each wraps the one before it — so an outbound
// request passes through every plugin's transform. Provider-agnostic by design:
// any request/response reshaping a deployment needs (auth quirks, header
// injection, body reshaping) lives out-of-tree in user space, not in this repo.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { globalPaths } from "../core/paths.js";

type FetchFn = typeof globalThis.fetch;

export interface RunnerPlugin {
  /** Human label for logs; falls back to the filename. */
  name?: string;
  /** Compose a transform onto the process fetch. `next` is the current global
   *  fetch (already wrapped by earlier plugins); return the replacement. */
  wrapFetch?(next: FetchFn): FetchFn;
}

/** Scan ~/.gaia/plugins/runner/*.mjs and compose each plugin's wrapFetch onto
 *  globalThis.fetch, in filename order. Never throws: a missing directory or a
 *  malformed plugin is skipped with a stderr warning, leaving fetch untouched.
 *  Idempotent per process is the caller's concern — call once at runner boot. */
export async function installRunnerPlugins(): Promise<void> {
  const dir = globalPaths.runnerPluginsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    return; // no ~/.gaia/plugins/runner dir — nothing to load
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      const mod = await import(pathToFileURL(path).href);
      const plugin = (mod.default ?? mod) as RunnerPlugin;
      if (typeof plugin?.wrapFetch !== "function") {
        console.warn(`[runner-plugins] skipped ${file}: no wrapFetch export`);
        continue;
      }
      const next: FetchFn = globalThis.fetch.bind(globalThis);
      const wrapped = plugin.wrapFetch(next);
      if (typeof wrapped !== "function") {
        console.warn(`[runner-plugins] skipped ${file}: wrapFetch did not return a function`);
        continue;
      }
      globalThis.fetch = wrapped;
      console.warn(`[runner-plugins] loaded ${plugin.name ?? file}`);
    } catch (error) {
      console.warn(`[runner-plugins] skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
