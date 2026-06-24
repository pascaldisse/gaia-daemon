// Apple `container` backend — a real Linux VM per turn (the strongest isolation
// gaia offers, and the cross-platform one). It wraps the agent-runner launch in
// `container run`: the workspace mounts read-write (a coding agent must edit its
// project, which is git-tracked / recoverable), the policy files are carved back
// to read-only, and the rest of the host is simply NOT mounted — invisible, so
// `rm -rf /` inside the guest hits nothing real.
//
// Unlike the seatbelt backend (which confines the SAME host node process), this
// runs the runner from a purpose-built Linux image: the host's macOS node +
// node_modules can't execute on linux/arm64. The image (GAIA_SANDBOX_IMAGE,
// default "gaia-agent") carries node + a Linux build of gaia under /opt/gaia and
// runs `node dist/cli.js __run-agent`; we only mount the workspace data into it.
// Build it once with: container build -t gaia-agent -f Containerfile.gaia-agent .
//
// Env: a container inherits nothing, so the runner's env (workspace/agent/room
// pointers, the bridge url + token, provider creds) is forwarded by NAME via
// `--env NAME` (spec.forwardEnv). The values come from this process's own
// environment at exec time, so secrets never land in argv (or `ps`).
//
// The bridge (memory writes / summon) lives on the daemon at 127.0.0.1, which is
// the GUEST's own loopback from inside the VM — unreachable. runner-host rewrites
// GAIA_DAEMON_URL to the host's address on the container network before forwarding
// it, and the daemon must listen on an interface the guest can reach (GAIA_HOST=
// 0.0.0.0). Reads (personas, memory) are disk: GAIA_HOME is mounted read-only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { registerSandbox, type SandboxSpec } from "./registry.js";

let availability: boolean | undefined;

function hasContainerBinary(): boolean {
  if (availability !== undefined) return availability;
  try {
    const result = spawnSync("command", ["-v", "container"], { shell: true, stdio: "ignore" });
    availability = result.status === 0;
  } catch {
    availability = false;
  }
  return availability;
}

// Is `child` the same path as, or nested under, `parent`? Used to skip mounting
// GAIA_HOME separately when it already sits inside the workspace mount.
function isUnder(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(`${p}/`);
}

export function buildContainerArgs(spec: SandboxSpec): string[] {
  const image = process.env.GAIA_SANDBOX_IMAGE?.trim() || "gaia-agent";
  const args = ["run", "--rm", "-i", "-w", spec.cwd];

  // The workspace (cwd) is writable — git-tracked, recoverable. Mounted at its
  // host path so the runner's GAIA_RUNNER_WORKSPACE env resolves inside the VM.
  args.push("-v", `${spec.cwd}:${spec.cwd}`);

  // Personas + long-term memory live under GAIA_HOME; the runner reads them off
  // disk (writes go through the bridge). Mount it read-only if it isn't already
  // covered by the workspace mount.
  const gaiaHome = process.env.GAIA_HOME?.trim();
  if (gaiaHome && existsSync(gaiaHome) && !isUnder(gaiaHome, spec.cwd)) {
    args.push("-v", `${gaiaHome}:${gaiaHome}:ro`);
  }

  // Extra writable grants (absolute, or subpaths already under cwd).
  for (const dir of spec.writable) args.push("-v", `${dir}:${dir}`);

  // The policy files that govern the next turn, carved back to read-only on top
  // of the writable workspace (overlapping ro-over-rw is honoured by the VM).
  for (const ro of spec.readonly) {
    if (existsSync(ro)) args.push("-v", `${ro}:${ro}:ro`);
  }

  // A container inherits no env — forward the names the runner needs. Values are
  // pulled from this process's environment by the `container` CLI, not embedded.
  for (const name of spec.forwardEnv) args.push("-e", name);

  if (spec.net === "none") args.push("--net", "none");

  // The image runs gaia's Linux build, not the host argv (which points at a
  // macOS node binary that doesn't exist in the guest).
  args.push(image, "node", "/opt/gaia/dist/cli.js", "__run-agent");
  return args;
}

registerSandbox({
  id: "apple-container",
  available: hasContainerBinary,
  wrap: (spec) => ({ command: "container", args: buildContainerArgs(spec) }),
});
