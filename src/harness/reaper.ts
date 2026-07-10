// Orphan reaping — adapted from nanoclaw's host-sweep/install-slug for gaia's
// process model. The daemon spawns one `gaia __run-agent` child per (room, agent)
// (summons included, since a summon is just a child room running through the same
// RunnerHost). Those children exit cleanly when the daemon closes their stdin, so
// a graceful shutdown leaves nothing behind. A SIGKILLed (crashed) daemon is the
// gap: a wedged child mid-syscall — or one blocked in a long tool subprocess —
// can miss the stdin EOF and linger. Nothing would reap those on restart without
// this sweep.
//
// Mechanism (nanoclaw's label-then-sweep, minus docker): every child carries a
// `--gaia-install <id>` marker on its argv, where the id is sha1(GAIA_HOME) — so
// two checkouts on one host never reap each other's children. On boot the daemon
// scans the process table for marked processes from this install that do not
// belong to the current daemon, SIGTERMs them, then escalates survivors to
// SIGKILL. Matching on the per-install marker (not a bare recorded PID) means PID
// reuse can't cause a wrong-process kill.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gaiaHome } from "../core/paths.js";

// Marker flag appended to every agent-runner's argv. The value is the install id;
// the runner itself ignores the flag (it reads only env), so it is a pure label.
export const INSTALL_MARKER_FLAG = "--gaia-install";

/** Per-install id: sha1 of the GAIA_HOME path, truncated. Deterministic per checkout. */
export function installId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

let cachedId: string | undefined;
/** This install's id, memoized off gaiaHome() so boot + every RunnerHost agree. */
export function currentInstallId(): string {
  if (cachedId === undefined) cachedId = installId(gaiaHome());
  return cachedId;
}

/** The marker argv pair a spawned child carries so the sweep can find it. */
export function installMarkerArgs(id = currentInstallId()): string[] {
  return [INSTALL_MARKER_FLAG, id];
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  command: string;
}

// Parse `ps -o pid=,ppid=,command=` rows: leading-space-padded pid, ppid, then the
// full command line (which itself contains spaces). Splitting on the first two
// whitespace runs keeps the command intact. Rows that don't parse are dropped.
export function parsePsTable(raw: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return entries;
}

// Pure selection: one daemon per install. A marked process not belonging to
// the current daemon is stale by definition (its daemon is dead or draining).
// The old parent-gone gate skipped runners of a still-draining predecessor during
// a fast relaunch, which caused a resumed turn to run in parallel with its
// surviving old runner (double-agent bug, 2026-07-10). Children of the current
// daemon are excluded too: at boot none exist yet, and the explicit
// ppid !== selfPid guard makes the function safe to call at any time.
export function selectOrphans(entries: ProcEntry[], id: string, selfPid: number): number[] {
  const marker = `${INSTALL_MARKER_FLAG} ${id}`;
  const orphans: number[] = [];
  for (const e of entries) {
    if (!e.command.includes(marker)) continue;
    if (e.pid === selfPid || e.ppid === selfPid) continue;
    orphans.push(e.pid);
  }
  return orphans;
}

export interface ReapOptions {
  id?: string;
  selfPid?: number;
  /** Test seam: return the raw `ps` table instead of shelling out. */
  listProcesses?: () => string;
  /** Test seam: how a pid is terminated (default process.kill with the provided signal). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Grace period after SIGTERM before SIGKILL escalation. */
  graceMs?: number;
  /** Poll interval while waiting for SIGTERM/SIGKILL to take effect. */
  pollMs?: number;
  /** Test seam: wait between polls. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

function defaultListProcesses(): string {
  // darwin/linux only; `ps` here doesn't take these flags on win32. axww = all
  // processes, unlimited-width command so the marker is never truncated.
  return execFileSync("ps", ["axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aliveWithMarker(entries: ProcEntry[], marker: string, pids: Set<number>): Set<number> {
  const alive = new Set<number>();
  for (const entry of entries) {
    if (pids.has(entry.pid) && entry.command.includes(marker)) alive.add(entry.pid);
  }
  return alive;
}

/**
 * Reap this install's stale agent-runner children left by a prior daemon.
 * Fully guarded and best-effort: off darwin/linux, on a `ps` failure, or on a
 * per-pid signal failure it logs and moves on — boot is never blocked.
 */
export async function reapOrphans(options: ReapOptions = {}): Promise<{ found: number; reaped: number }> {
  const id = options.id ?? currentInstallId();
  const selfPid = options.selfPid ?? process.pid;
  const log = options.log ?? (() => {});
  const list = options.listProcesses ?? defaultListProcesses;
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const graceMs = options.graceMs ?? 2000;
  const pollMs = Math.max(1, options.pollMs ?? 100);
  const sleep = options.sleep ?? defaultSleep;

  if (!options.listProcesses && process.platform === "win32") return { found: 0, reaped: 0 };

  try {
    let entries: ProcEntry[];
    try {
      entries = parsePsTable(list());
    } catch (error) {
      log(`orphan sweep: could not list processes (${error instanceof Error ? error.message : String(error)})`);
      return { found: 0, reaped: 0 };
    }

    const orphans = selectOrphans(entries, id, selfPid);
    const found = orphans.length;
    if (found === 0) return { found: 0, reaped: 0 };

    const originalPids = new Set(orphans);
    const marker = `${INSTALL_MARKER_FLAG} ${id}`;

    const signalPid = (pid: number, signal: NodeJS.Signals): void => {
      try {
        kill(pid, signal);
      } catch (error) {
        // ESRCH (already gone) is fine; anything else we just note.
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "ESRCH") log(`orphan sweep: failed to signal pid ${pid} with ${signal} (${code ?? error})`);
      }
    };

    for (const pid of orphans) signalPid(pid, "SIGTERM");

    const relistAlive = (pids: Set<number>): Set<number> => {
      try {
        return aliveWithMarker(parsePsTable(list()), marker, pids);
      } catch (error) {
        log(`orphan sweep: could not relist processes (${error instanceof Error ? error.message : String(error)})`);
        return pids;
      }
    };

    let stillAlive = new Set(originalPids);
    let elapsed = 0;
    while (elapsed < graceMs && stillAlive.size > 0) {
      await sleep(pollMs);
      elapsed += pollMs;
      stillAlive = relistAlive(stillAlive);
    }

    const neededSigkill = stillAlive.size;
    for (const pid of stillAlive) signalPid(pid, "SIGKILL");

    await sleep(pollMs);
    const survivors = relistAlive(originalPids).size;
    const reaped = found - survivors;
    const survivedText = survivors > 0 ? `; SURVIVED ${survivors}` : `; survived 0`;
    log(`orphan sweep: found ${found} stale runner(s) from a prior daemon (install ${id}); SIGKILL needed for ${neededSigkill}${survivedText}.`);
    return { found, reaped };
  } catch (error) {
    log(`orphan sweep: failed (${error instanceof Error ? error.message : String(error)})`);
    return { found: 0, reaped: 0 };
  }
}
