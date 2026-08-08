// macOS Seatbelt backend (`sandbox-exec`). It ships with macOS — no image, no
// daemon, no plugin — so it is the isolation that actually runs on this machine.
// Since apple-container was dropped, it is gaia's only real backend; off darwin
// an isolated turn fail-closes (refuses to run) rather than running naked.
//
// Posture — two axes:
//  • WRITES (allowlist): nothing is writable except the workspace (cwd, unless
//    cwdWritable === false), temp, and regenerable caches. The policy files and
//    any spec-declared credential store are carved back to read-only inside
//    those trees, so a confined turn can neither rewrite its own governance nor
//    tamper with the keys it can read.
//  • READS (denylist): reads stay open EXCEPT a sensitive set — SSH/cloud/CI
//    credentials and the user's documents — which are denied, with the workspace
//    and GAIA_HOME re-allowed on top. This curbs exfiltration of unrelated
//    secrets by a buggy or prompt-injected turn.
//
// Honest residual: the API key the turn itself uses is in its env by necessity,
// so this cannot hide THAT key — that is what the credential proxy closes (see
// services/proxy.ts + RunnerHost's uniform wiring). Reads of OTHER projects
// under ~ are left open by default because runtimes/installs live there and a
// blanket deny breaks module resolution; pass extra paths via spec.denyRead to
// tighten case by case.
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { env } from "../../core/env.js";
import { registerSandbox, type SandboxSpec } from "./spec.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Seatbelt matches canonical (symlink-resolved) paths — the classic /tmp ->
// /private/tmp gotcha. Canonicalize everything we name; fall back to the literal
// for paths that do not exist yet (a deny rule for a missing path is harmless).
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

// Credential stores + personal data denied reads by default. Missing paths are
// harmless (a deny on a nonexistent path never matches). Deliberately NOT here:
// a harness's own credential store — the turn must read its own key; hiding it
// when the credential proxy replaces it arrives via spec.denyRead.
function defaultSensitiveReads(home: string): string[] {
  return [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.config/gcloud`,
    `${home}/.config/gh`,
    `${home}/.config/op`,
    `${home}/.kube`,
    `${home}/.docker`,
    `${home}/.netrc`,
    `${home}/.npmrc`,
    `${home}/.pypirc`,
    `${home}/Library/Keychains`,
    `${home}/Documents`,
    `${home}/Desktop`,
    `${home}/Downloads`,
  ];
}

export function buildSeatbeltProfile(spec: SandboxSpec): string {
  const home = canon(homedir());
  const cwdWritable = spec.cwdWritable !== false;
  const writable = [
    ...(cwdWritable ? [canon(spec.cwd)] : []),
    canon(tmpdir()),
    "/private/tmp",
    "/private/var/folders",
    // Regenerable runtime caches the turn legitimately writes — NOT the user's
    // irreplaceable files (node/npm/esbuild live here). A harness's own state
    // dir (session + model state under ~) arrives via spec.writable, declared
    // as data on its HarnessSpec — this backend names no harness's paths.
    `${home}/Library/Caches`,
    `${home}/.cache`,
    ...spec.writable.map(canon),
  ];
  // Read-only even inside the writable trees above (policy files + declared
  // credential stores). Last match wins in SBPL, so these denies override the
  // allow.
  const readonly = spec.readonly.map(canon);
  // Sensitive reads denied, then the workspace + GAIA_HOME re-allowed on top so
  // a cwd that happens to sit under a denied tree (e.g. ~/Documents) still reads.
  const denyRead = [...defaultSensitiveReads(home), ...(spec.denyRead ?? [])].map(canon);
  const readAllow = [canon(spec.cwd)];
  const gaiaHome = env("GAIA_HOME");
  if (gaiaHome) readAllow.push(canon(gaiaHome));

  const lines = [
    "(version 1)",
    "(allow default)",
    // Writes: deny-all, allow the workspace/temp/caches + character devices,
    // then re-deny the policy files + credential store.
    "(deny file-write*)",
    `(allow file-write* ${subpaths(writable)} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/random") (literal "/dev/urandom") (regex #"^/dev/fd/"))`,
    // Guard the empty case: a bare `(deny file-write*)` filters NOTHING — it
    // would re-deny every write, including the workspace allowed above.
    ...(readonly.length > 0 ? [`(deny file-write* ${subpaths(readonly)})`] : []),
    // Reads: deny the sensitive set, then re-allow the workspace + GAIA_HOME.
    `(deny file-read* ${subpaths(denyRead)})`,
    `(allow file-read* ${subpaths(readAllow)})`,
  ];
  if (spec.net === "none") lines.push("(deny network*)");
  return lines.join("\n");
}

registerSandbox({
  id: "macos-seatbelt",
  available: () => process.platform === "darwin" && existsSync(SANDBOX_EXEC),
  wrap: (spec) => ({ command: SANDBOX_EXEC, args: ["-p", buildSeatbeltProfile(spec), ...spec.argv] }),
});
