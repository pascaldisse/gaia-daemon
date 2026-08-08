// Observer hooks — shell commands the DAEMON runs at room-lifecycle points
// (preTurn / postTurn / toolUse / error). Because they run at the room layer,
// they are uniform for every harness by construction: no per-harness hook
// translation, and no gating — the sandbox is the boundary, hooks observe.
//
// Contract (mirrors the familiar claude-hook shape): the event payload is
// JSON on stdin; GAIA_HOOK_EVENT / GAIA_ROOM_ID / GAIA_AGENT_ID ride in the
// env. Fire-and-forget with a per-hook timeout: a failing or slow hook is
// logged and never blocks or fails the turn that triggered it.

import { spawn } from "node:child_process";
import type { HookCommand } from "../core/types.js";

export type HookEvent = "preTurn" | "postTurn" | "toolUse" | "error";

const DEFAULT_TIMEOUT_SEC = 10;
/** Cap free-text payload fields so a huge reply never floods a hook. */
export const HOOK_TEXT_CAP = 4_000;

export interface HookRunContext {
  cwd: string;
  log?: (message: string) => void;
}

/** Run every hook registered for an event. Returns a promise that settles when
 * all spawned hooks exit — callers that must not wait simply don't await it. */
export function runHooks(hooks: HookCommand[] | undefined, event: HookEvent, payload: Record<string, unknown>, ctx: HookRunContext): Promise<void> {
  if (!hooks?.length) return Promise.resolve();
  const body = JSON.stringify({ event, ...payload });
  return Promise.all(hooks.map((hook) => runHook(hook, event, body, payload, ctx))).then(() => {});
}

function runHook(hook: HookCommand, event: HookEvent, body: string, payload: Record<string, unknown>, ctx: HookRunContext): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", hook.command], {
        cwd: ctx.cwd,
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...process.env,
          GAIA_HOOK_EVENT: event,
          GAIA_ROOM_ID: typeof payload.roomId === "string" ? payload.roomId : "",
          GAIA_AGENT_ID: typeof payload.agentId === "string" ? payload.agentId : "",
        },
      });
    } catch (error) {
      ctx.log?.(`hook (${event}) failed to spawn: ${error instanceof Error ? error.message : String(error)}`);
      resolve();
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk));
    const timer = setTimeout(() => {
      ctx.log?.(`hook (${event}) timed out after ${hook.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s: ${hook.command}`);
      child.kill("SIGKILL");
    }, (hook.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1_000);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      ctx.log?.(`hook (${event}) failed: ${error.message}`);
      resolve();
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && !signal) {
        ctx.log?.(`hook (${event}) exited ${code}: ${hook.command}${stderr.trim() ? ` — ${stderr.trim().slice(0, 200)}` : ""}`);
      }
      resolve();
    });
    child.stdin?.on("error", () => {}); // hook may exit without reading stdin
    child.stdin?.end(body);
  });
}
