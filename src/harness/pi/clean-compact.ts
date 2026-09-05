import { NO_SESSION_TO_COMPACT, type CompactResult } from "../../core/types.js";
import { loadCleanCompactionOverride } from "../../domain/clean-summaries.js";
import type { PiSessionLike } from "./session.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { newestContentEntryId } from "./compaction.js";

// Explicit inline allowlist entry; no external discovery, cwd parsing, or global /compact interception.
export function cleanCompactExtension(roomId: string, agentId: string, activeSummary: () => string | undefined): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", (event, ctx) => {
      const summary = activeSummary();
      if (summary === undefined) return;
      // Current branch only: abandoned sibling entries cannot become a live floor.
      const floor = newestContentEntryId(
        (event.branchEntries ?? ctx.sessionManager.getEntries()) as unknown as Record<string, unknown>[],
        event.preparation.firstKeptEntryId,
      );
      console.warn(`compact-clean: room=${roomId} agent=${agentId} newestValidCutId=${floor} preparationFloor=${event.preparation.firstKeptEntryId}`);
      const modified = new Set([...event.preparation.fileOps.edited, ...event.preparation.fileOps.written]);
      return { compaction: {
        summary, firstKeptEntryId: floor, tokensBefore: event.preparation.tokensBefore,
        details: { source: "clean-compact", readFiles: [...event.preparation.fileOps.read].filter(file => !modified.has(file)).sort(), modifiedFiles: [...modified].sort() },
      } };
    });
    pi.on("session_compact", (event) => {
      if (activeSummary() !== undefined)
        console.warn(`compact-clean: committed room=${roomId} agent=${agentId} floor=${event.compactionEntry.firstKeptEntryId}`);
    });
  };
}

// Clean-only lifecycle; ordinary PiCompaction remains byte-identical to main.
export class PiCleanCompaction {
  private readonly summaries = new Map<string, string>();
  constructor(
    private readonly sessions: { get(roomId: string): { session: PiSessionLike } | undefined },
    private readonly restore: (roomId: string) => Promise<PiSessionLike | undefined>,
    private readonly agentId: string,
    private readonly loadSummary = loadCleanCompactionOverride,
  ) {}
  extension(roomId: string, factory = cleanCompactExtension): ExtensionFactory {
    return factory(roomId, this.agentId, () => this.summaries.get(roomId));
  }
  // Scope exclusion to this clean operation; ordinary handlers otherwise receive the same event/context.
  guardOrdinaryExtension(roomId: string, factory: ExtensionFactory): ExtensionFactory {
    return (pi) => factory(new Proxy(pi, {
      get: (target, property, receiver) => {
        if (property !== "on") return Reflect.get(target, property, receiver);
        return (event: string, handler: (...args: unknown[]) => unknown) => {
          const on = target.on as (event: string, handler: (...args: unknown[]) => unknown) => void;
          on(event, (...args) => {
            if (event === "session_before_compact" && this.summaries.has(roomId)) return;
            return handler(...args);
          });
        };
      },
    }));
  }
  async clean(roomId: string): Promise<CompactResult> {
    const summary = this.loadSummary(roomId, this.agentId);
    if (!summary?.trim()) return { compacted: false, message: "nothing to compact — no clean summary registered for this room and agent." };
    const session = this.sessions.get(roomId)?.session ?? await this.restore(roomId);
    if (!session?.compact) return NO_SESSION_TO_COMPACT;
    this.summaries.set(roomId, summary);
    const settings = session.settingsManager;
    const original = settings?.getCompactionKeepRecentTokens();
    settings?.applyOverrides({ compaction: { keepRecentTokens: 0 } });
    try {
      const result = await this.native(session);
      const after = result.estimatedTokensAfter !== undefined ? ` → ~${result.estimatedTokensAfter}` : "";
      return { compacted: true, message: `session compacted (${result.tokensBefore} tokens before${after}).`, summary: result.summary };
    } catch (error) {
      if (/already compacted|too small/i.test(error instanceof Error ? error.message : String(error)))
        return { compacted: true, message: "clean compaction: pi session already minimal; advanced room floor+cursor.", summary };
      throw error;
    } finally {
      if (original !== undefined) settings?.applyOverrides({ compaction: { keepRecentTokens: original } });
      this.summaries.delete(roomId);
    }
  }
  private async native(session: PiSessionLike) {
    try { return await session.compact!(); }
    catch (error) {
      if (!/too small/i.test(error instanceof Error ? error.message : String(error)) || !session.settingsManager) throw error;
      const settings = session.settingsManager;
      const original = settings.getCompactionKeepRecentTokens();
      settings.applyOverrides({ compaction: { keepRecentTokens: 2000 } });
      try { return await session.compact!(); }
      finally { settings.applyOverrides({ compaction: { keepRecentTokens: original } }); }
    }
  }
}
