// Apple `container` backend (a Linux VM, like the pi skill's sandbox). It wraps
// the agent-runner launch in `container run`: the workspace mounts read-only,
// declared subdirs mount read-write, the rest of the host stays invisible.
//
// The image (GAIA_SANDBOX_IMAGE, default "gaia-agent") must carry node + the
// gaia runner; building it is a separate concern, exactly like the pi skill's
// Containerfile. Until a workspace opts into this backend (config.sandbox.backend
// = "apple-container"), nothing here runs — the default backend is "none".
import { spawnSync } from "node:child_process";
import { registerSandbox } from "./registry.js";

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

registerSandbox({
  id: "apple-container",
  available: hasContainerBinary,
  wrap: (spec) => {
    const image = process.env.GAIA_SANDBOX_IMAGE?.trim() || "gaia-agent";
    const args = ["run", "--rm", "-i", "-w", spec.cwd, "-v", `${spec.cwd}:${spec.cwd}:ro`];
    for (const dir of spec.writable) args.push("-v", `${dir}:${dir}`);
    if (spec.net === "none") args.push("--net", "none");
    args.push(image, ...spec.argv);
    return { command: "container", args };
  },
});
