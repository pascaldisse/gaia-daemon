// `gaia __sandbox-exec` — the single confinement entrypoint. Any caller (the pi
// skill's launcher, a future harness) hands it a child argv plus a policy and
// gets that child run inside the SAME sandbox the daemon uses, built by the same
// resolveSandboxLaunch. This is the one place a sandbox is constructed, so there
// is no second copy of the profile logic to drift.
//
// Fail-closed: if the chosen backend is unavailable, it refuses to run the child
// (exit 1) rather than running it unconfined — the property callers depend on.
//
// Usage:
//   gaia __sandbox-exec --backend <id> --cwd <dir> [--writable <dir>]…
//        [--deny-read <dir>]… [--net full|none] [--readonly-cwd] -- <cmd> [args…]
import { spawn } from "node:child_process";
import { resolveSandboxLaunch, type SandboxPolicy } from "./index.js";

export async function runSandboxExec(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  if (sep === -1) {
    process.stderr.write("gaia __sandbox-exec: missing `--` before the child command\n");
    return 2;
  }
  const flags = argv.slice(0, sep);
  const childArgv = argv.slice(sep + 1);
  if (childArgv.length === 0) {
    process.stderr.write("gaia __sandbox-exec: no child command after `--`\n");
    return 2;
  }

  let backend = "macos-seatbelt";
  let cwd = process.cwd();
  let net: "full" | "none" = "full";
  let readonlyCwd = false;
  const writable: string[] = [];
  const denyRead: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    switch (flag) {
      case "--backend": backend = flags[++i]; break;
      case "--cwd": cwd = flags[++i]; break;
      case "--writable": writable.push(flags[++i]); break;
      case "--deny-read": denyRead.push(flags[++i]); break;
      case "--net": net = flags[++i] === "none" ? "none" : "full"; break;
      case "--readonly-cwd": readonlyCwd = true; break;
      default:
        process.stderr.write(`gaia __sandbox-exec: unknown flag ${flag}\n`);
        return 2;
    }
  }

  const policy: SandboxPolicy = { enabled: true, backend, net };
  let launch;
  try {
    launch = await resolveSandboxLaunch(policy, childArgv, cwd, {
      writable,
      denyRead,
      cwdWritable: !readonlyCwd,
    });
  } catch (error) {
    // Backend unavailable / unknown → refuse. Do NOT run the child unsandboxed.
    process.stderr.write(`gaia __sandbox-exec: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  return await new Promise<number>((resolve) => {
    const child = spawn(launch.command, launch.args, { cwd, stdio: "inherit", env: process.env });
    // Forward termination so killing this wrapper tears the sandboxed child down
    // too. Callers (the daemon, the pi-agent manager) kill the wrapper's pid; on
    // darwin sandbox-exec execs into the target, so the signal reaches the child.
    const onTerm = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    };
    const onInt = (): void => {
      try {
        child.kill("SIGINT");
      } catch {
        /* already gone */
      }
    };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    const done = (code: number): void => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve(code);
    };
    child.on("error", (error) => {
      process.stderr.write(`gaia __sandbox-exec: spawn failed: ${error.message}\n`);
      done(1);
    });
    child.on("exit", (code, signal) => done(signal ? 128 : code ?? 0));
  });
}
