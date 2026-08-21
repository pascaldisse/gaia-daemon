// Bridge-backed runtime deps the runner subprocess hands to the real harness
// runtime: every harness writes memory and summons over the SAME HTTP surface
// the `gaia` CLI uses (the daemon is the single writer); reads stay on disk,
// which any read-only sandbox allows.

import { daemonPost, type DaemonTarget } from "../core/daemon-client.js";
import { MemoryStore, type MemoryAction, type MemoryMutationResult } from "../domain/memory.js";
import type { MemorySearchHit } from "../domain/workspace-index.js";
import type { ContextDietOverrides, ContextDietPolicy } from "../domain/context-diet.js";
import { LLM_PROXY_MOUNT } from "./protocol.js";
import type { ContextDietAccess, ContextDietView, HarnessHost, RecallSearch, ResumeCreate, SummonCreate, ToolResultFetch } from "./spec.js";

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

/** recallSearch that POSTs to the daemon (deep search + reranker run
 * daemon-side: embeddings keys and the fact/episode index never enter this
 * process). `scroll` rides the same endpoint via `around`. */
export function bridgeRecallSearch(target: DaemonTarget): RecallSearch {
  const search = async (query: string, limit?: number) => {
    const { ok, payload } = await daemonPost(target, "/api/harness/recall", { query, ...(limit ? { limit } : {}) });
    if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "recall failed");
    return Array.isArray(payload.hits) ? (payload.hits as MemorySearchHit[]) : [];
  };
  return Object.assign(search, {
    scroll: async (hitId: number, options?: { span?: number; offset?: number }) => {
      const { ok, payload } = await daemonPost(target, "/api/harness/recall", { around: hitId, ...(options?.span ? { span: options.span } : {}), ...(options?.offset ? { offset: options.offset } : {}) });
      if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "recall scroll failed");
      return typeof payload.result === "string" ? payload.result : "";
    },
    ghoulRoom: async (roomId: string, options?: { offset?: number; limit?: number }) => {
      const { ok, payload } = await daemonPost(target, "/api/harness/recall", { ghoul_room: roomId, ...(options?.offset !== undefined ? { offset: options.offset } : {}), ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
      if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "ghoul room read failed");
      return typeof payload.result === "string" ? payload.result : "";
    },
    ghoulLedgers: async (query?: string) => {
      const { ok, payload } = await daemonPost(target, "/api/harness/recall", { ghoul_ledgers: true, ...(query ? { query } : {}) });
      if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "ledger search failed");
      return typeof payload.result === "string" ? payload.result : "";
    },
  });
}

/** summonCreate that POSTs to the daemon's summon endpoint (the coordinator).
 * ALWAYS fire-and-forget — a summon never blocks the calling turn, on any
 * harness or transport. The call resolves with a launch acknowledgment; the
 * worker's result is delivered back into the calling room by the coordinator
 * (a message from the worker plus a queued turn for the caller) when it
 * settles — the subagent callback. */
export function bridgeSummonCreate(target: DaemonTarget): SummonCreate {
  return async ({ task, agentId }) => {
    const { ok, payload } = await daemonPost(target, "/api/harness/summon", { agent: agentId, task });
    if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "summon failed");
    return typeof payload.result === "string" ? payload.result : "summon launched";
  };
}

/** Same daemon bridge operation used by the `gaia resume` CLI command. */
export function bridgeResumeCreate(target: DaemonTarget): ResumeCreate {
  return async ({ roomId, message }) => {
    const { ok, payload } = await daemonPost(target, "/api/harness/resume", { room: roomId, message });
    if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "resume failed");
    return typeof payload.result === "string" ? payload.result : "resume queued";
  };
}

/** Pages the ORIGINAL, uncollapsed call/args/result for a diet-collapsed own
 * tool-call stub back — backs the `tool_result_fetch` gaia-tool verb
 * (09-MEMORY-CONTEXT). Same daemon bridge shape as every other harness dep. */
export function bridgeToolResultFetch(target: DaemonTarget): ToolResultFetch {
  return async ({ sessionId, entryId, offset, limit }) => {
    const { ok, payload } = await daemonPost(target, "/api/harness/tool-result-fetch", { sessionId, entryId, offset, limit });
    if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "tool_result_fetch failed");
    return {
      text: typeof payload.text === "string" ? payload.text : "",
      totalLength: typeof payload.totalLength === "number" ? payload.totalLength : 0,
      hasMore: payload.hasMore === true,
    };
  };
}

/** Read/patch the context-diet policy — backs the `diet` gaia-tool verb (the
 * `/diet` room command reaches the SAME daemon-side RoomService methods
 * in-process, without this bridge). */
export function bridgeContextDiet(target: DaemonTarget): ContextDietAccess {
  const parseView = (payload: Record<string, unknown>): ContextDietView => ({
    effective: payload.effective as ContextDietPolicy,
    roomOverrides: (payload.roomOverrides ?? {}) as ContextDietOverrides,
  });
  return {
    get: async () => {
      const { ok, payload } = await daemonPost(target, "/api/harness/context-diet", {});
      if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "context-diet read failed");
      return parseView(payload);
    },
    set: async ({ scope, patch }) => {
      const { ok, payload } = await daemonPost(target, "/api/harness/context-diet", { scope, patch });
      if (!ok) throw new Error(typeof payload.error === "string" ? payload.error : "context-diet write failed");
      return parseView(payload);
    },
  };
}

/** A HarnessHost that re-uses the fixed token the daemon minted for this runner.
 * The subprocess can't mint (no HMAC secret) and doesn't need to: the token is
 * per-(agent, room) already. */
export function fixedTokenHost(target: DaemonTarget): HarnessHost {
  return { baseUrl: target.url, llmProxyUrl: `${target.url}${LLM_PROXY_MOUNT}`, mintToken: () => target.token };
}
