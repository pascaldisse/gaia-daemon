// macOS Seatbelt backend (`sandbox-exec`). It ships with macOS — no image, no
// daemon, no plugin — so it is the isolation that actually runs on this machine
// today, unlike apple-container (which needs a built image + a working
// `container` install). It is the default real backend on darwin.
//
// Posture: keep every capability the turn legitimately needs — read anything,
// reach the network, spawn subprocesses — but confine WRITES to the workspace it
// was pointed at (plus temp and regenerable caches) and deny writes to the rest
// of the host. That removes the blast radius that actually matters (the user's
// other files, their documents, the system) while a coding agent can still edit
// the project it is working on (which is git-tracked and recoverable).
//
// Two carve-outs are kept read-only even though they sit inside writable trees:
// the policy files that govern the next turn (config.json, project agent.json —
// passed in spec.readonly) and the pi credential store (~/.pi/agent/auth.json).
// So a confined turn can neither rewrite its own governance nor tamper with the
// API keys it can already read.
//
// Residual, named on purpose: reads and network stay open, so this stops
// destruction and tampering, not exfiltration. That is the agreed trade.
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { registerSandbox, type SandboxSpec } from "./registry.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Seatbelt matches canonical (symlink-resolved) paths — the classic /tmp ->
// /private/tmp gotcha. Canonicalize everything we name; fall back to the literal
// for paths that do not exist yet (a deny rule for a missing file is harmless).
function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// SBPL strings are double-quoted; escape the two metacharacters that matter.
function quote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function subpaths(paths: string[]): string {
  return paths.map((p) => `(subpath ${quote(p)})`).join(" ");
}

export function buildSeatbeltProfile(spec: SandboxSpec): string {
  const home = canon(homedir());
  const writable = [
    canon(spec.cwd),
    canon(tmpdir()),
    "/private/tmp",
    "/private/var/folders",
    // Regenerable runtime state/caches the turn legitimately writes — NOT the
    // user's irreplaceable files. The pi harness keeps session + model state
    // under ~/.pi (and a turn deadlocks if denied it); node/npm/esbuild use the
    // cache dirs. auth.json under ~/.pi is carved back out below.
    `${home}/.pi`,
    `${home}/Library/Caches`,
    `${home}/.cache`,
    ...spec.writable.map(canon),
  ];
  // Read-only even inside the writable trees above. Last match wins in SBPL, so
  // these denies override the allow.
  const readonly = [...spec.readonly.map(canon), canon(`${home}/.pi/agent/auth.json`)];
  const lines = [
    "(version 1)",
    "(allow default)",
    // Nothing is writable...
    "(deny file-write*)",
    // ...except the workspace, temp, regenerable caches, and character devices.
    `(allow file-write* ${subpaths(writable)} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/random") (literal "/dev/urandom") (regex #"^/dev/fd/"))`,
    // ...but never the policy files or the credential store.
    `(deny file-write* ${subpaths(readonly)})`,
  ];
  if (spec.net === "none") lines.push("(deny network*)");
  return lines.join("\n");
}

registerSandbox({
  id: "macos-seatbelt",
  available: () => process.platform === "darwin" && existsSync(SANDBOX_EXEC),
  wrap: (spec) => ({ command: SANDBOX_EXEC, args: ["-p", buildSeatbeltProfile(spec), ...spec.argv] }),
});
