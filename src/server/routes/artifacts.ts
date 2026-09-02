import type { GaiaTool } from "../../harness/spec.js";
import { json, parseBody } from "../../core/http.js";
import { authorizeHarnessCall, stringField, type RouteContext } from "../route.js";
import { numberField } from "./memory.js";

export const artifactRoutePrefix = "/api/harness/tools";

// The unified `gaia` tool's operation dispatch (artifact CRUD, web search/
// fetch, caryll compress/expand) — one POST endpoint, `operation` in the body
// selects the verb. Gate is operation-shaped, not a fixed per-route verb:
// artifact-* operations need the "artifact" grant, everything else needs the
// unified "gaia" grant — so this calls authorizeHarnessCall(ctx, "tools")
// (which the shared preamble carves out of its own generic gate) and then
// applies its own operation-based gate once the body/operation is known.
async function harnessTools(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== artifactRoutePrefix) return false;
  const authorized = await authorizeHarnessCall(ctx, "tools");
  if (!authorized) return true;
  const { claims, workspace } = authorized;
  const body = await parseBody(ctx.request);
  const input = body as Record<string, unknown>;
  const operation = stringField(body, "operation");
  const gate: GaiaTool = operation?.startsWith("artifact-") ? "artifact" : "gaia";
  if (!ctx.daemon.harnessGaiaTools(workspace, claims.agentId).includes(gate)) {
    json(ctx.response, 403, { error: `This agent's harness does not grant the ${gate} tool.` });
    return true;
  }
  const providers = ctx.daemon.harnessToolProviders();
  const location = { rootDir: workspace.rootDir, roomId: claims.roomId };
  const text = (field: string) => stringField(body, field) ?? "";
  try {
    let result: unknown;
    switch (operation) {
      case "artifact-list": result = await providers.artifacts.list(location); break;
      case "artifact-read": result = await providers.artifacts.read(location, text("artifactId")); break;
      case "artifact-create": result = await providers.artifacts.create(location, { name: text("name"), kind: text("kind") as "html" | "json" | "design", mediaType: text("mediaType"), payload: text("payload") }); break;
      case "artifact-update": result = await providers.artifacts.update(location, text("artifactId"), { ...(stringField(body, "name") !== undefined ? { name: text("name") } : {}), ...(stringField(body, "kind") !== undefined ? { kind: text("kind") as "html" | "json" | "design" } : {}), ...(stringField(body, "mediaType") !== undefined ? { mediaType: text("mediaType") } : {}), ...(stringField(body, "payload") !== undefined ? { payload: text("payload") } : {}) }); break;
      case "web-search": result = await providers.web.search({ query: text("query"), ...(numberField(body, "maxResults") !== undefined ? { maxResults: numberField(body, "maxResults") } : {}), ...(stringField(body, "provider") !== undefined ? { provider: text("provider") as "brave" | "tavily" | "serper" } : {}) }); break;
      case "web-fetch": result = await providers.web.fetch({ url: text("url"), ...(numberField(body, "maxBytes") !== undefined ? { maxBytes: numberField(body, "maxBytes") } : {}), ...(typeof input.transcript === "boolean" ? { transcript: input.transcript } : {}), ...(stringField(body, "lang") !== undefined ? { lang: text("lang") } : {}), ...(typeof input.comments === "boolean" || typeof input.comments === "number" ? { comments: input.comments } : {}) }); break;
      case "caryll-compress": result = await providers.caryll.compress(text("text")); break;
      case "caryll-expand": result = await providers.caryll.expand(text("text")); break;
      default: json(ctx.response, 400, { error: "unknown tool operation" }); return true;
    }
    json(ctx.response, 200, { ok: true, result });
  } catch (error) {
    json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

export async function handleArtifacts(ctx: RouteContext): Promise<boolean> {
  return harnessTools(ctx);
}
