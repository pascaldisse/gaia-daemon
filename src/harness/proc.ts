// Shared child-process primitives for the harness layer. Every harness spawns a
// child, reads its stdout as newline-delimited records, and watches stderr —
// only the framing ON TOP differs (an NDJSON parse + stdin prompt, a JSON-RPC
// handler, the runner host's stderr forwarding + breaker logic). This wraps the
// common scaffold (spawn + per-line callback + captured stderr) and hands the
// raw ChildProcess + readline interface back so each runtime layers its own
// behavior. It takes the binary/args/io as DATA — no branch on the harness id
// (AGENTS.md §RULE #0). Also home to the CLI-entry resolution the helpers that
// re-launch THIS install's `gaia` need (the runner subprocess, harness shims).

import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface SpawnLineReaderOptions {
  /** Binary to launch (e.g. "claude", "codex"). */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Own process group so a group-kill can signal the whole tree (abort). */
  detached?: boolean;
  /** Called once per non-empty stdout line (already trimmed of trailing newline). */
  onLine: (line: string) => void;
}

export interface SpawnLineReaderHandle {
  /** The underlying child; callers layer stdin writes / exit handlers / kill on it. */
  proc: ChildProcess;
  /** The stdout line reader; close it when tearing down. */
  rl: Interface;
  /** Accumulated stderr so far (for diagnostics / startup errors). */
  stderr(): string;
}

/**
 * Spawn `command` and invoke `onLine` for each non-empty stdout line, while
 * accumulating stderr. Returns the raw child + readline interface so the caller
 * can attach stdin delivery, exit/error handling, and kill semantics itself.
 */
export function spawnLineReader(options: SpawnLineReaderOptions): SpawnLineReaderHandle {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  if (options.detached) spawnOptions.detached = true;

  const proc: ChildProcess = spawn(options.command, options.args, spawnOptions);

  // Diagnostics buffer, capped: a long-lived runner with a chatty harness must
  // not grow daemon memory without bound. The most recent output is what a
  // startup/crash error needs, so keep the tail.
  const STDERR_CAP = 64 * 1024;
  let stderrAccum = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderrAccum = (stderrAccum + chunk).slice(-STDERR_CAP);
  });

  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    options.onLine(line);
  });

  return {
    proc,
    rl,
    stderr: () => stderrAccum,
  };
}

/**
 * Best-effort terminate of `proc` and its whole process group. Kills the group
 * (negative pid) so any tool/bash grandchildren die too, escalating to SIGKILL
 * after a grace period in case the child ignores SIGTERM — so abort is
 * guaranteed to stop the agent. Requires the child to have been spawned
 * `detached`. No-op once the child is gone.
 */
export function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  signalGroup("SIGTERM");
  const grace = setTimeout(() => signalGroup("SIGKILL"), 2000);
  grace.unref?.();
  proc.once("exit", () => clearTimeout(grace));
}

/** True when an error looks like a missing-binary ENOENT from `spawn`. */
export function isMissingBinary(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * A uniform "<label> is unavailable" startup error. On ENOENT it names the
 * missing `binary`; otherwise it carries the underlying message plus any
 * captured stderr. `binary`/`label` are data so this never branches on which
 * harness called it (AGENTS.md §RULE #0).
 */
export function missingBinaryError(binary: string, label: string, error: unknown, stderr?: string): Error {
  if (isMissingBinary(error)) {
    return new Error(`${label} is unavailable: the \`${binary}\` CLI was not found in PATH.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  const details = stderr?.trim();
  return new Error(`${label} is unavailable: ${message}${details ? `\n\n${binary} stderr:\n${details}` : ""}`);
}

/**
 * Absolute path to this install's CLI entry: cli.js when built, else cli.ts
 * (dev/tsx). Resolved relative to the harness directory (src2/harness/ →
 * repo cli is one level up).
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
