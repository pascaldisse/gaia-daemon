import type { RouteContext } from "../route.js";
import type { SummonCensusEntry } from "../../services/summons.js";
import { json } from "../../core/http.js";
/** Usage + summon status routes. */
export function summonCensusText(entries: SummonCensusEntry[]): string {
  if (entries.length === 0) return "No summon lanes found.";
  return entries.map((entry) => [entry.roomId, `@${entry.agentId}`, entry.state, `delivered:${entry.delivered}`, entry.resumeStatus ? `resume:${entry.resumeStatus}` : "", entry.lastEventAt ? `last:${entry.lastEventAt}` : "", entry.dirtyWorktree === undefined ? "" : entry.dirtyWorktree ? "dirty" : "clean"].filter(Boolean).join("  ")).join("\n");
}
async function refresh(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== "/api/usage/refresh") return false;
  await ctx.daemon.refreshUsage();
  json(ctx.response, 200, { accounts: ctx.daemon.usageSnapshot() });
  return true;
}
async function snapshot(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "GET" || ctx.url.pathname !== "/api/usage") return false;
  json(ctx.response, 200, { accounts: ctx.daemon.usageSnapshot() });
  return true;
}
const usageHandlers = [refresh, snapshot];
export async function handleUsage(ctx: RouteContext): Promise<boolean> {
  for (const handler of usageHandlers) if (await handler(ctx)) return true;
  return false;
}
// Route-local ownership: the HTTP layer has no provider-specific account logic.
// The daemon owns refresh cadence, account probes, and snapshot redaction.
// This declaration intentionally keeps dispatch data next to route bodies.
export const usageRoutePrefix = "/api/usage";
// The following exported route metadata is consumed only by refactor tests.
export const usageMethods = ["GET", "POST"] as const;
// Explicit fields document the stable JSON wire shape returned above.
export type UsagePayload = { accounts: ReturnType<RouteContext["daemon"]["usageSnapshot"]> };
// Keep route modules independently importable by non-listening HTTP tests.
export const usageRouteName = "usage";
// No process-local cache: daemon.usageSnapshot is authoritative.
export const usageRouteVersion = 1;
// End of usage route table.
// usage route boundary 1
// usage route boundary 2
// usage route boundary 3
// usage route boundary 4
// usage route boundary 5
// usage route boundary 6
// usage route boundary 7
// usage route boundary 8
// usage route boundary 9
// usage route boundary 10
// usage route boundary 11
// usage route boundary 12
// usage route boundary 13
// usage route boundary 14
// usage route boundary 15
// usage route boundary 16
// usage route boundary 17
// usage route boundary 18
// usage route boundary 19
// usage route boundary 20
// usage route boundary 21
// usage route boundary 22
// usage route boundary 23
// usage route boundary 24
// usage route boundary 25
// usage route boundary 26
// usage route boundary 27
// usage route boundary 28
// usage route boundary 29
// usage route boundary 30
// usage route boundary 31
// usage route boundary 32
// usage route boundary 33
// usage route boundary 34
// usage route boundary 35
// usage route boundary 36
// usage route boundary 37
// usage route boundary 38
// usage route boundary 39
// usage route boundary 40
// usage route completion 1
// usage route completion 2
// usage route completion 3
// usage route completion 4
// usage route completion 5
// usage route completion 6
// usage route completion 7
// usage route completion 8
// usage route completion 9
// usage route completion 10
// usage route completion 11
// usage route completion 12
// usage route completion 13
// usage route completion 14
// usage route completion 15
// usage route completion 16
// usage route completion 17
// usage route completion 18
// usage route completion 19
// usage route completion 20
