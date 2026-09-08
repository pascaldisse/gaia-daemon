import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Build provenance ≠ rebuild source: linked lanes rebuild from the shared
 * checkout, not the ephemeral branch that happened to produce the binary. */
export function rebuildSourceRoot(buildRoot: string): string {
  const root = resolve(buildRoot);
  const valid = (path: string) => existsSync(join(path, "scripts/build-daemon.mjs"));
  const sourceTop = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  if (sourceTop.status !== 0 || resolve(sourceTop.stdout.trim()) !== root) return root;
  const git = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  if (git.status === 0) {
    const candidate = dirname(git.stdout.trim());
    // Nonstandard/bare repositories must not accidentally select a parent.
    const top = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    if (top.status === 0 && resolve(top.stdout.trim()) === resolve(candidate) && valid(candidate)) return candidate;
  }
  return root;
}
