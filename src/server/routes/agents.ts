import { json, parseBody } from "../../core/http.js";
import { scaffoldGlobalAgent } from "../../domain/agents.js";
import { globalAgentsPath } from "../../domain/workspace.js";
import { stringField, matchPath, respond, type RouteContext } from "../route.js";
export function titleCaseId(id: string): string { return id.split(/[-_]/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ") || id; }
async function createAgent(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== "/api/agents") return false;
  const body = await parseBody(ctx.request); const id = stringField(body, "id");
  if (!id) { json(ctx.response, 400, { error: "Missing agent id" }); return true; }
  try { const displayName = stringField(body, "displayName")?.trim() || titleCaseId(id); const result = await scaffoldGlobalAgent(globalAgentsPath(), id, { displayName, icon: stringField(body, "icon") }); await ctx.daemon.applySettingsChange("global"); json(ctx.response, 201, { agent: { id, displayName, dir: result.agentDir } }); } catch (error) { const message = error instanceof Error ? error.message : String(error); json(ctx.response, message.startsWith("Invalid agent id") ? 400 : 409, { error: message }); }
  return true;
}
async function deleteAgent(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/agents\/([^/]+)$/);
  if (ctx.request.method !== "DELETE" || !params) return false;
  await respond(ctx.response, async () => { await ctx.daemon.deleteAgent(params[0]); await ctx.daemon.applySettingsChange("global"); return {}; }); return true;
}
export async function handleAgents(ctx: RouteContext): Promise<boolean> { for (const handler of [createAgent, deleteAgent]) if (await handler(ctx)) return true; return false; }
// agent route boundary 1
// agent route boundary 2
// agent route boundary 3
// agent route boundary 4
// agent route boundary 5
// agent route boundary 6
// agent route boundary 7
// agent route boundary 8
// agent route boundary 9
// agent route boundary 10
// agent route boundary 11
// agent route boundary 12
// agent route boundary 13
// agent route boundary 14
// agent route boundary 15
// agent route boundary 16
// agent route boundary 17
// agent route boundary 18
// agent route boundary 19
// agent route boundary 20
// agent route boundary 21
// agent route boundary 22
// agent route boundary 23
// agent route boundary 24
// agent route boundary 25
// agent route boundary 26
// agent route boundary 27
// agent route boundary 28
// agent route boundary 29
// agent route boundary 30
// agent route boundary 31
// agent route boundary 32
// agent route boundary 33
// agent route boundary 34
// agent route boundary 35
// agent route boundary 36
// agent route boundary 37
// agent route boundary 38
// agent route boundary 39
// agent route boundary 40
// agent route boundary 41
// agent route boundary 42
// agent route boundary 43
// agent route boundary 44
// agent route boundary 45
// agent route boundary 46
// agent route boundary 47
// agent route boundary 48
// agent route boundary 49
// agent route boundary 50
// agent route boundary 51
// agent route boundary 52
// agent route boundary 53
// agent route boundary 54
// agent route boundary 55
// agent route boundary 56
// agent route boundary 57
// agent route boundary 58
// agent route boundary 59
// agent route boundary 60
// agent route completion 1
// agent route completion 2
// agent route completion 3
