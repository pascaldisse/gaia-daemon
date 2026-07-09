import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** The trimmed value of `process.env[name]`, or undefined when unset/blank. */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

// GUI launchers (Finder/launchd, the native app shell) hand children a bare
// PATH — the user's real one lives in interactive-shell rc files that never
// ran. Harness CLIs (`claude`, `codex`, …) install into user bin dirs, so a
// daemon launched that way can't see them while the same daemon launched from
// a terminal can. Rather than trusting the launcher, the process repairs its
// own PATH once at entry: well-known bin dirs that exist on disk are appended
// (never prepended — an inherited PATH still wins on conflicts).
function pathCandidates(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    // npm-global installs live next to the node running us (nvm layouts).
    dirname(process.execPath),
  ];
}

/** `current` with any missing-but-existing well-known bin dirs appended. */
export function hardenedPath(current: string | undefined, candidates: string[] = pathCandidates()): string {
  const entries = (current ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(entries);
  for (const dir of candidates) {
    if (seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    entries.push(dir);
  }
  return entries.join(delimiter);
}

/** Repair `process.env.PATH` in place; every child spawn inherits the result. */
export function hardenPath(): void {
  process.env.PATH = hardenedPath(process.env.PATH);
}
