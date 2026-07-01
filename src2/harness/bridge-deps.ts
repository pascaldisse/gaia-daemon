// Bridge-backed runtime deps the runner subprocess hands to the real harness
// runtime: every harness writes memory and summons over the SAME HTTP surface
// the `gaia` CLI uses (the daemon is the single writer); reads stay on disk,
// which any read-only sandbox allows.

import { daemonPost, type DaemonTarget } from "../core/daemon-client.js";
import { MemoryStore, type MemoryAction, type MemoryMutationResult } from "../domain/memory.js";
import { LLM_PROXY_MOUNT } from "./protocol.js";
import type { HarnessHost, SummonCreate } from "./spec.js";

/** MemoryStore whose writes go to the daemon (single writer); reads stay on disk. */
export class BridgeMemoryStore extends MemoryStore {
  constructor(private readonly target: DaemonTarget) {
    super();
  }

  override async mutate(dir: string, file: string, action: MemoryAction, options: { content?: string; oldText?: string }): Promise<MemoryMutationResult> {
    try {
      const { ok, payload } = await daemonPost(this.target, "/api/harness/memory", {
        action,
        file,
        content: options.content ?? "",
        old_text: options.oldText ?? "",
      });
      // The daemon performed (or rejected) the write; re-read from disk for the
      // post-state the tool echoes back.
      const state = await this.readState(dir, file);
      if (!ok) return { ok: false, message: typeof payload.error === "string" ? payload.error : "memory write failed", state };
      // Require the daemon's explicit ok:true — a 200 with an empty/non-JSON
      // body (e.g. a mis-routed request the SPA answered) must NOT read as a
      // successful write.
      if (payload.ok !== true) {
        return { ok: false, message: typeof payload.message === "string" ? payload.message : "memory write not confirmed by daemon", state };
      }
      return { ok: true, message: typeof payload.message === "string" ? payload.message : "ok", state };
    } catch (error) {
      const state = await this.readState(dir, file);
      return { ok: false, message: `memory bridge error: ${error instanceof Error ? error.message : String(error)}`, state };
    }
  }
}

/** summonCreate that POSTs to the daemon's summon endpoint (the coordinator). */
export function bridgeSummonCreate(target: DaemonTarget): SummonCreate {
  return async ({ task, agentId }) => {
    const { ok, payload } = await daemonPost(target, "/api/harness/summon", { agent: agentId, task });
    if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "summon failed");
    return typeof payload.result === "string" ? payload.result : "(no output)";
  };
}

/** A HarnessHost that re-uses the fixed token the daemon minted for this runner.
 * The subprocess can't mint (no HMAC secret) and doesn't need to: the token is
 * per-(agent, room) already. */
export function fixedTokenHost(target: DaemonTarget): HarnessHost {
  return { baseUrl: target.url, llmProxyUrl: `${target.url}${LLM_PROXY_MOUNT}`, mintToken: () => target.token };
}
