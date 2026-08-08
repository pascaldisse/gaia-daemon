import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    // …but a GUI-launched daemon may be running a DIFFERENT node (e.g.
    // homebrew's) than the user's nvm default, hiding CLIs installed under
    // nvm's bin. Resolve nvm's default version explicitly.
    ...nvmDefaultBin(home),
  ];
}

// The bin dir of nvm's default node version, if nvm is installed: matches
// `~/.nvm/alias/default` (e.g. "24", "v24.11.1") against
// `~/.nvm/versions/node/*`, falling back to the lexically-newest version.
function nvmDefaultBin(home: string): string[] {
  const versionsDir = join(home, ".nvm", "versions", "node");
  let versions: string[];
  try {
    versions = readdirSync(versionsDir).filter((v) => v.startsWith("v"));
  } catch {
    return [];
  }
  if (versions.length === 0) return [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let pick = versions[versions.length - 1];
  try {
    const alias = readFileSync(join(home, ".nvm", "alias", "default"), "utf8").trim();
    const wanted = alias.startsWith("v") ? alias : `v${alias}`;
    const match = versions.filter((v) => v === wanted || v.startsWith(`${wanted}.`)).pop();
    if (match) pick = match;
  } catch {
    // no default alias — newest version stands.
  }
  return [join(versionsDir, pick, "bin")];
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
