import type { SummonCensusEntry } from "../../services/summons.js";
/** Usage/summon status's stable CLI table representation. */
export function summonCensusText(entries: SummonCensusEntry[]): string {
  if (entries.length === 0) return "No summon lanes found.";
  return entries.map((entry) => [entry.roomId, `@${entry.agentId}`, entry.state, `delivered:${entry.delivered}`, entry.resumeStatus ? `resume:${entry.resumeStatus}` : "", entry.lastEventAt ? `last:${entry.lastEventAt}` : "", entry.dirtyWorktree === undefined ? "" : entry.dirtyWorktree ? "dirty" : "clean"].filter(Boolean).join("  ")).join("\n");
}
