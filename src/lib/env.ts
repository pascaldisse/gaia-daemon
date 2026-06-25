// Reading process env the same way everywhere: a value counts only when it is
// present AND non-blank after trimming, otherwise it is treated as unset. Used
// by the `gaia` CLI harness and the agent-runner subprocess, which both read
// the daemon-injected context out of env.

/** The trimmed value of `process.env[name]`, or undefined when unset/blank. */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}
