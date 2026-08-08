// Daemon-side token authority for harness subprocesses. A subprocess receives
// a bearer token via env (GAIA_DAEMON_TOKEN); the daemon verifies it on
// /api/harness/* and resolves the (workspace, agent, room) it was minted for.
// Tokens are HMAC-signed with a per-process secret — valid only for the daemon
// that spawned the subprocess and only for its lifetime.
//
// The subprocess-side counterparts (BridgeMemoryStore, bridgeSummonCreate,
// fixedTokenHost) live in harness/bridge-deps.ts — they run inside the runner.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { LLM_PROXY_MOUNT } from "../harness/protocol.js";
import type { HarnessHost } from "../harness/spec.js";

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
