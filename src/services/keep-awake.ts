// "Keep laptop awake while GAIA runs" (Global Settings ▸ General). macOS-only:
// a single daemon-managed `caffeinate -s -i -m -w <daemon pid>` child, spawned
// while the setting is on and killed when it's off or the daemon shuts down
// gracefully. The `-w` flag makes caffeinate self-exit if the daemon dies
// hard (crash, kill -9) even though we never detach it — belt and suspenders
// against an orphaned child.
//
// Setting persistence follows the same shape as WorkspaceRegistry
// (daemon.ts): a `keepAwake` boolean living in ~/.gaia/app.json, read via
// readJson/writeJsonAtomic (core/store.ts).
//
// Supersedes the earlier launchd agent (com.gaia.keepawake, REMOTE-STACK.md):
// migrateLegacyLaunchdAgent() boots it out and deletes its plist, once, the
// first time this code runs. It touches ONLY that exact label/file — never
// com.gaia.edge-proxy or anything else in ~/Library/LaunchAgents.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { globalPaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import type { KeepAwakeCapability } from "../core/types.js";

const execFileAsync = promisify(execFile);

export const KEEP_AWAKE_DEFAULT = true;

const LEGACY_LAUNCHD_LABEL = "com.gaia.keepawake";

function legacyPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`);
}

/** caffeinate only exists on macOS; the setting is inert everywhere else. */
export function keepAwakeSupported(): boolean {
  return process.platform === "darwin";
}

/** Read the `keepAwake` flag from ~/.gaia/app.json. Missing file/key → the
 * documented default (TRUE). */
export async function readKeepAwakeSetting(): Promise<boolean> {
  const config = ((await readJson(globalPaths.appSettings())) ?? {}) as { keepAwake?: boolean };
  return typeof config.keepAwake === "boolean" ? config.keepAwake : KEEP_AWAKE_DEFAULT;
}

/** Persist the flag, preserving whatever else lives in app.json
 * (recentWorkspaces, from WorkspaceRegistry) — read-merge-write, same as
 * WorkspaceRegistry.add/remove. */
export async function writeKeepAwakeSetting(enabled: boolean): Promise<void> {
  const config = ((await readJson(globalPaths.appSettings())) ?? {}) as Record<string, unknown>;
  await writeJsonAtomic(globalPaths.appSettings(), { ...config, keepAwake: enabled });
}

export interface KeepAwakeManagerOptions {
  log?: (message: string) => void;
  /** Injection seam for tests. */
  spawnImpl?: typeof spawn;
}

/** Owns the single caffeinate child. Idempotent by construction: ensure(true)
 * is a no-op while a child is already alive; ensure(false) kills it if
 * running and is a no-op otherwise. */
export class KeepAwakeManager {
  private child: ChildProcess | undefined;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: KeepAwakeManagerOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  private log(message: string): void {
    this.options.log?.(`keep-awake: ${message}`);
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** Apply the desired state. No-op on non-macOS (the setting is inert there). */
  async ensure(enabled: boolean): Promise<void> {
    if (!keepAwakeSupported()) return;
    if (!enabled) {
      this.kill();
      return;
    }
    if (this.running) return; // never spawn a second child while one is alive
    const child = this.spawnImpl("caffeinate", ["-s", "-i", "-m", "-w", String(process.pid)], { detached: false, stdio: "ignore" });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.log(`caffeinate exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
    });
    child.once("error", (error) => {
      if (this.child === child) this.child = undefined;
      this.log(`caffeinate spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.child = child;
    this.log(`caffeinate started (pid ${child.pid ?? "?"}, watching daemon pid ${process.pid})`);
  }

  private kill(): void {
    if (!this.child) return;
    this.log(`caffeinate stopped (pid ${this.child.pid ?? "?"})`);
    this.child.kill();
    this.child = undefined;
  }

  /** Graceful daemon shutdown: always kill, regardless of the setting. */
  dispose(): void {
    this.kill();
  }
}

/** Resolve the capability payload served in /api/app. */
export async function keepAwakeCapability(): Promise<KeepAwakeCapability> {
  return { supported: keepAwakeSupported(), enabled: await readKeepAwakeSetting() };
}

/** One-time migration off the launchd-managed keepawake agent — daemon-managed
 * caffeinate (above) supersedes it. Boots out `com.gaia.keepawake` and deletes
 * its plist if present. Best-effort and silent on the common case (agent
 * already gone after the first restart on this code): failures are logged,
 * never thrown. */
export async function migrateLegacyLaunchdAgent(options: { log?: (message: string) => void; execFileImpl?: typeof execFileAsync } = {}): Promise<void> {
  if (!keepAwakeSupported()) return;
  const log = (message: string): void => options.log?.(`keep-awake: ${message}`);
  const run = options.execFileImpl ?? execFileAsync;
  const uid = process.getuid?.();
  if (uid === undefined) return;

  let bootedOut = false;
  try {
    // Exit 0 → the agent is currently loaded.
    await run("launchctl", ["print", `gui/${uid}/${LEGACY_LAUNCHD_LABEL}`]);
    await run("launchctl", ["bootout", `gui/${uid}/${LEGACY_LAUNCHD_LABEL}`]);
    bootedOut = true;
    log(`booted out legacy launchd agent ${LEGACY_LAUNCHD_LABEL}`);
  } catch {
    // Not loaded, or bootout failed because it already wasn't — nothing to do.
  }

  const plist = legacyPlistPath();
  if (!existsSync(plist)) return;
  try {
    await rm(plist);
    log(`removed legacy launchd plist ${plist}`);
  } catch (error) {
    log(`failed to remove legacy plist ${plist}: ${error instanceof Error ? error.message : String(error)}${bootedOut ? " (agent was booted out; plist cleanup can be retried)" : ""}`);
  }
}
