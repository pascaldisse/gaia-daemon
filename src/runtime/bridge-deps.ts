// Bridge-backed dependencies the agent-runner hands to the real runtime so that,
// running in a subprocess, its daemon-coupled tool calls reach the daemon — the
// single writer for memory and the owner of the summon coordinator. This is the
// uniform tool-IO surface: in-process Pi no longer privileged with direct
// MemoryStore/summonCreate access; every harness writes memory and summons over
// the same HTTP bridge the `gaia` CLI uses. Reads (memory list/read, recall)
// still hit disk, which any read-only sandbox allows.

import { MemoryStore, type MemoryMutationResult, type MemoryAction } from "../memory/memory-store.js";
import type { HarnessHost } from "../app/harness-bridge.js";
import type { SummonCreate } from "../tools/summon-tool.js";

interface BridgeTarget {
  url: string;
  token: string;
}

async function daemonPost(target: BridgeTarget, path: string, body: unknown): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`${target.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
}

/** MemoryStore whose writes go to the daemon (single writer); reads stay on disk. */
export class BridgeMemoryStore extends MemoryStore {
  constructor(private readonly target: BridgeTarget) {
    super();
  }

  override async mutate(
    dir: string,
    file: string,
    action: MemoryAction,
    options: { content?: string; oldText?: string },
  ): Promise<MemoryMutationResult> {
    try {
      const { ok, payload } = await daemonPost(this.target, "/api/harness/memory", {
        action,
        file,
        content: options.content ?? "",
        old_text: options.oldText ?? "",
      });
      // The daemon performed (or rejected) the write; re-read the file from disk
      // for the post-state the tool echoes back.
      const state = await this.readState(dir, file);
      if (!ok) return { ok: false, message: typeof payload.error === "string" ? payload.error : "memory write failed", state };
      // Require the daemon's explicit ok:true. A 200 with an empty/non-JSON body
      // (e.g. a mis-routed request the SPA answered) must NOT read as a successful
      // write — fail loud rather than silently dropping the content.
      if (payload.ok !== true) {
        return { ok: false, message: typeof payload.message === "string" ? payload.message : "memory write not confirmed by daemon", state };
      }
      return {
        ok: true,
        message: typeof payload.message === "string" ? payload.message : "ok",
        state,
      };
    } catch (error) {
      const state = await this.readState(dir, file);
      return { ok: false, message: `memory bridge error: ${error instanceof Error ? error.message : String(error)}`, state };
    }
  }
}

/** summonCreate that POSTs to the daemon's summon endpoint (the coordinator). */
export function bridgeSummonCreate(target: BridgeTarget): SummonCreate {
  return async ({ task, agentId }) => {
    const { ok, payload } = await daemonPost(target, "/api/harness/summon", { agent: agentId, task });
    if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "summon failed");
    return typeof payload.result === "string" ? payload.result : "(no output)";
  };
}

/** A HarnessHost that re-uses the fixed token the daemon minted for this runner.
 *  The subprocess can't mint (it has no HMAC secret), and doesn't need to: it is
 *  per-(agent, room), so the one token already carries the right claims. Used by
 *  the subprocess-spawning harnesses (Claude/Codex) for their own `gaia` CLI. */
export function fixedTokenHost(target: BridgeTarget): HarnessHost {
  return { baseUrl: target.url, mintToken: () => target.token };
}
