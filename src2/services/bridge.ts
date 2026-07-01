// Bridges harness subprocesses to the daemon for memory writes and summon.
// A subprocess receives a bearer token via env (GAIA_DAEMON_TOKEN); the daemon
// verifies it on /api/harness/* and resolves the (workspace, agent, room) it
// was minted for. Tokens are HMAC-signed with a per-process secret — valid
// only for the daemon that spawned the subprocess and only for its lifetime.
//
// Also home of the bridge-backed runtime deps (BridgeMemoryStore etc.): every
// harness writes memory and summons over the SAME HTTP surface the `gaia` CLI
// uses; reads stay on disk (any read-only sandbox allows them).

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { daemonPost, type DaemonTarget } from "../core/daemon-client.js";
import { MemoryStore, type MemoryAction, type MemoryMutationResult } from "../domain/memory.js";
import type { HarnessHost, SummonCreate } from "../harness/spec.js";
import { LLM_PROXY_MOUNT } from "./proxy.js";

export interface HarnessTokenClaims {
  workspaceId: string;
  agentId: string;
  roomId: string;
  /** Whether this token may create summons; false for summoned (nested) agents. */
  allowSummon: boolean;
}

export class HarnessBridge {
  private readonly secret = randomUUID();

  constructor(private readonly baseUrl: string) {}

  hostFor(workspaceId: string, options: { allowSummon?: boolean } = {}): HarnessHost {
    const allowSummon = options.allowSummon !== false;
    return {
      baseUrl: this.baseUrl,
      llmProxyUrl: `${this.baseUrl}${LLM_PROXY_MOUNT}`,
      mintToken: ({ agentId, roomId }) => this.sign({ workspaceId, agentId, roomId, allowSummon }),
    };
  }

  verify(token: string | undefined): HarnessTokenClaims | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const got = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<HarnessTokenClaims>;
      if (typeof claims.workspaceId !== "string" || typeof claims.agentId !== "string" || typeof claims.roomId !== "string") return null;
      return {
        workspaceId: claims.workspaceId,
        agentId: claims.agentId,
        roomId: claims.roomId,
        allowSummon: claims.allowSummon === true,
      };
    } catch {
      return null;
    }
  }

  private sign(claims: HarnessTokenClaims): string {
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }
}

// --- bridge-backed runtime deps (used by the runner subprocess) ---------------

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
