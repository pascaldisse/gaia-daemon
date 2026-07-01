// Orphan reaping — adapted from nanoclaw's host-sweep/install-slug for gaia's
// process model. The daemon spawns one `gaia __run-agent` child per (room, agent)
// (summons included, since a summon is just a child room running through the same
// RunnerHost). Those children exit cleanly when the daemon closes their stdin, so
// a graceful shutdown leaves nothing behind. A SIGKILLed (crashed) daemon is the
// gap: a wedged child mid-syscall — or one blocked in a long tool subprocess —
// can miss the stdin EOF and linger, reparented to init. Nothing would reap those
// on restart without this sweep.
//
// Mechanism (nanoclaw's label-then-sweep, minus docker): every child carries a
// `--gaia-install <id>` marker on its argv, where the id is sha1(GAIA_HOME) — so
// two checkouts on one host never reap each other's children. On boot the daemon
// scans the process table for marked processes whose parent is gone (reparented
// to init / no longer live) and SIGTERMs them. Matching on the per-install marker
// (not a bare recorded PID) means PID reuse can't cause a wrong-process kill.

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

// Pure selection: an orphan is a process that carries THIS install's marker, is
// not the daemon itself, and whose parent is gone — reparented to init (ppid 1)
// or a ppid that isn't a live pid in the table. The live-pid check keeps a sibling
// daemon's healthy children (whose parent is still running) safe. Children of the
// current daemon are excluded too: at boot none exist yet, and the explicit
// ppid !== selfPid guard makes the function safe to call at any time.
export function selectOrphans(entries: ProcEntry[], id: string, selfPid: number): number[] {
  const marker = `${INSTALL_MARKER_FLAG} ${id}`;
  const livePids = new Set(entries.map((e) => e.pid));
  const orphans: number[] = [];
  for (const e of entries) {
    if (!e.command.includes(marker)) continue;
    if (e.pid === selfPid || e.ppid === selfPid) continue;
    if (e.ppid === 1 || !livePids.has(e.ppid)) orphans.push(e.pid);
  }
  return orphans;
}

export interface ReapOptions {
  id?: string;
  selfPid?: number;
  /** Test seam: return the raw `ps` table instead of shelling out. */
  listProcesses?: () => string;
  /** Test seam: how a pid is terminated (default SIGTERM via process.kill). */
  kill?: (pid: number) => void;
  log?: (message: string) => void;
}

function defaultListProcesses(): string {
  // darwin/linux only; `ps` here doesn't take these flags on win32. axww = all
  // processes, unlimited-width command so the marker is never truncated.
  return execFileSync("ps", ["axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Reap this install's orphaned agent-runner children left by a crashed daemon.
 * Fully guarded and best-effort: off darwin/linux, on a `ps` failure, or on a
 * per-pid kill failure it logs and moves on — boot is never blocked.
 */
export function reapOrphans(options: ReapOptions = {}): { found: number; reaped: number } {
  const id = options.id ?? currentInstallId();
  const selfPid = options.selfPid ?? process.pid;
  const log = options.log ?? (() => {});
  const list = options.listProcesses ?? defaultListProcesses;
  const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));

  if (!options.listProcesses && process.platform === "win32") return { found: 0, reaped: 0 };

  let entries: ProcEntry[];
  try {
    entries = parsePsTable(list());
  } catch (error) {
    log(`orphan sweep: could not list processes (${error instanceof Error ? error.message : String(error)})`);
    return { found: 0, reaped: 0 };
  }

  const orphans = selectOrphans(entries, id, selfPid);
  let reaped = 0;
  for (const pid of orphans) {
    try {
      kill(pid);
      reaped++;
    } catch (error) {
      // ESRCH (already gone) is fine; anything else we just note.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") log(`orphan sweep: failed to signal pid ${pid} (${code ?? error})`);
    }
  }
  if (orphans.length > 0) log(`orphan sweep: reaped ${reaped}/${orphans.length} leftover runner(s) from a prior daemon (install ${id}).`);
  return { found: orphans.length, reaped };
}
