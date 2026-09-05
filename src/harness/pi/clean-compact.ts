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
