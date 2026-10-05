// Shared child-process runner for the local STT engines (apple, whistle) -- one
// copy, never per-engine (zero duplication).
import { spawn } from "node:child_process";
export interface RunResult { code: number; stdout: string; stderr: string }

export function runProcess(command: string[], signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c) => out.push(c));
    child.stderr?.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

