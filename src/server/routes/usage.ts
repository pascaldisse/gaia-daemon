import type { RouteContext } from "../route.js";
import type { SummonCensusEntry } from "../../services/summons.js";
import { json } from "../../core/http.js";

export function summonCensusText(entries: SummonCensusEntry[]): string {
  if (entries.length === 0) return "No summon lanes found.";
  return entries.map((entry) => [entry.roomId, `@${entry.agentId}`, entry.state, `delivered:${entry.delivered}`, entry.resumeStatus ? `resume:${entry.resumeStatus}` : "", entry.lastEventAt ? `last:${entry.lastEventAt}` : "", entry.dirtyWorktree === undefined ? "" : entry.dirtyWorktree ? "dirty" : "clean"].filter(Boolean).join("  ")).join("\n");
}
// Manual usage refresh (the popover's ↻ button) — probes every declared
// account NOW, bypassing throttle and backoff, and answers with the fresh
// snapshot directly so the button works even when SSE hiccups.
async function refresh(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== "/api/usage/refresh") return false;
  await ctx.daemon.refreshUsage();
  json(ctx.response, 200, { accounts: ctx.daemon.usageSnapshot() });
  return true;
}

export async function handleUsage(ctx: RouteContext): Promise<boolean> {
  return refresh(ctx);
}
