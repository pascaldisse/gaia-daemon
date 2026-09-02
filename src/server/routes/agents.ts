import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../../core/config.js";
import { json, parseBody } from "../../core/http.js";
import { readJson, writeJsonAtomic } from "../../core/store.js";
import { scaffoldGlobalAgent } from "../../domain/agents.js";
import { findAccount } from "../../domain/accounts.js";
import { globalAgentsPath } from "../../domain/workspace.js";
import { stringField, matchPath, respond, type RouteContext } from "../route.js";

export function titleCaseId(id: string): string { return id.split(/[-_]/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ") || id; }

async function createAgent(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== "/api/agents") return false;
  const body = await parseBody(ctx.request);
  const id = stringField(body, "id");
  if (!id) { json(ctx.response, 400, { error: "Missing agent id" }); return true; }
  try {
    const displayName = stringField(body, "displayName")?.trim() || titleCaseId(id);
    const result = await scaffoldGlobalAgent(globalAgentsPath(), id, { displayName, icon: stringField(body, "icon") });
    await ctx.daemon.applySettingsChange("global");
    json(ctx.response, 201, { agent: { id, displayName, dir: result.agentDir } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(ctx.response, message.startsWith("Invalid agent id") ? 400 : 409, { error: message });
  }
  return true;
}
// Reversible agent delete: move the agent dir to trash (recoverable), then
// reload global settings so the agents list refreshes.
async function deleteAgent(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/agents\/([^/]+)$/);
  if (ctx.request.method !== "DELETE" || !params) return false;
  await respond(ctx.response, async () => {
    await ctx.daemon.deleteAgent(params[0]);
    await ctx.daemon.applySettingsChange("global");
    return {};
  });
  return true;
}
// Per-agent account binding: which named account (if any) an agent's
// harness subprocess runs under. Harness-blind — compares harness id
// STRINGS pulled from agent.json/accounts.json data, never a literal id.
async function agentAccount(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/agents\/([^/]+)\/account$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const agentId = params[0];
  const configPath = join(globalAgentsPath(), agentId, "agent.json");
  if (!existsSync(configPath)) { json(ctx.response, 404, { error: `unknown agent '${agentId}'` }); return true; }
  const body = await parseBody(ctx.request);
  const rawAccount = (body as { account?: unknown } | undefined)?.account;
  const account = typeof rawAccount === "string" && rawAccount.trim() ? rawAccount.trim() : null;
  try {
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;
    if (account) {
      const record = findAccount(account);
      if (!record) { json(ctx.response, 400, { error: `unknown account '${account}'` }); return true; }
      const agentHarness = typeof config.harness === "string" && config.harness.trim() ? config.harness : DEFAULTS.harness;
      if (record.harness !== agentHarness) {
        json(ctx.response, 400, { error: `account '${account}' is for harness '${record.harness}', agent uses '${agentHarness}'` });
        return true;
      }
      config.account = account;
    } else {
      delete config.account;
    }
    await writeJsonAtomic(configPath, config);
    await ctx.daemon.applySettingsChange("global");
    json(ctx.response, 200, { agent: { id: agentId, account } });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
async function agentThinking(ctx: RouteContext): Promise<boolean> {
  const params = matchPath(ctx.url.pathname, /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/);
  if (ctx.request.method !== "POST" || !params) return false;
  const body = await parseBody(ctx.request);
  const level = stringField(body, "level");
  const roomId = stringField(body, "roomId");
  if (level === undefined) { json(ctx.response, 400, { error: "Missing thinking level" }); return true; }
  try {
    const result = await ctx.daemon.applyThinking(params[0], roomId, params[1], level);
    json(ctx.response, 200, { scope: result.scope, thinking: level || undefined });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

const agentHandlers = [createAgent, deleteAgent, agentAccount, agentThinking];
export async function handleAgents(ctx: RouteContext): Promise<boolean> {
  for (const handler of agentHandlers) if (await handler(ctx)) return true;
  return false;
}
