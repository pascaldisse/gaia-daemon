import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { LLM_PROXY_MOUNT } from "./llm-proxy.js";

// Bridges harness subprocesses (Claude/Codex) to the daemon for memory writes
// and summon. A subprocess receives a bearer token via env (GAIA_DAEMON_TOKEN);
// the daemon verifies it on /api/harness/* and resolves the (workspace, agent,
// room) it was minted for. Tokens are HMAC-signed with a per-process secret, so
// they are only valid for the daemon that spawned the subprocess and only for
// that daemon's lifetime. The endpoints bind to localhost.

export interface HarnessTokenClaims {
  workspaceId: string;
  agentId: string;
  roomId: string;
  /** Whether this token may create summons; false for summoned (nested) agents. */
  allowSummon: boolean;
}

/** Per-workspace handle passed into runtimes so they can mint turn tokens. */
export interface HarnessHost {
  baseUrl: string;
  /** Mount of the in-daemon LLM credential proxy; a redirected harness posts here
   *  with its per-turn token (the same GAIA_DAEMON_TOKEN) and the daemon injects
   *  the real key. See src/app/llm-proxy.ts. */
  llmProxyUrl: string;
  mintToken(claims: { agentId: string; roomId: string }): string;
}

export class HarnessBridge {
  private readonly secret = randomUUID();

  constructor(private readonly baseUrl: string) {}

  // allowSummon defaults true; the controller passes false for the summon
  // manager so a summoned agent cannot recursively summon (parity with Pi,
  // which withholds summonCreate from summoned agents).
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
      if (typeof claims.workspaceId !== "string" || typeof claims.agentId !== "string" || typeof claims.roomId !== "string") {
        return null;
      }
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
