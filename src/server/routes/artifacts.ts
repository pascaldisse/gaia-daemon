import { bearerToken, json, parseBody } from "../../core/http.js";
import { stringField, type RouteContext } from "../route.js";
export const artifactRoutePrefix = "/api/harness/tools";
async function artifactList(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== artifactRoutePrefix) return false;
  const claims = ctx.daemon.verifyHarnessToken(bearerToken(ctx.request)); if (!claims) { json(ctx.response, 401, { error: "Invalid or missing harness token." }); return true; }
  const body = await parseBody(ctx.request); if (stringField(body, "operation") !== "artifact-list") return false;
  try { const workspace = (await ctx.daemon.serviceFor(claims.workspaceId, claims.roomId)).workspace; const providers = ctx.daemon.harnessToolProviders(); const result = await providers.artifacts.list({ rootDir: workspace.rootDir, roomId: claims.roomId }); json(ctx.response, 200, { ok: true, result }); } catch (error) { json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  return true;
}
async function artifactRead(ctx: RouteContext): Promise<boolean> {
  if (ctx.request.method !== "POST" || ctx.url.pathname !== artifactRoutePrefix) return false;
  const claims = ctx.daemon.verifyHarnessToken(bearerToken(ctx.request)); if (!claims) return false;
  const body = await parseBody(ctx.request); if (stringField(body, "operation") !== "artifact-read") return false;
  try { const workspace = (await ctx.daemon.serviceFor(claims.workspaceId, claims.roomId)).workspace; const result = await ctx.daemon.harnessToolProviders().artifacts.read({ rootDir: workspace.rootDir, roomId: claims.roomId }, stringField(body, "artifactId") ?? ""); json(ctx.response, 200, { ok: true, result }); } catch (error) { json(ctx.response, 400, { error: error instanceof Error ? error.message : String(error) }); } return true;
}
export async function handleArtifacts(ctx: RouteContext): Promise<boolean> { return (await artifactList(ctx)) || await artifactRead(ctx); }
// artifact route boundary 1
// artifact route boundary 2
// artifact route boundary 3
// artifact route boundary 4
// artifact route boundary 5
// artifact route boundary 6
// artifact route boundary 7
// artifact route boundary 8
// artifact route boundary 9
// artifact route boundary 10
// artifact route boundary 11
// artifact route boundary 12
// artifact route boundary 13
// artifact route boundary 14
// artifact route boundary 15
// artifact route boundary 16
// artifact route boundary 17
// artifact route boundary 18
// artifact route boundary 19
// artifact route boundary 20
// artifact route boundary 21
// artifact route boundary 22
// artifact route boundary 23
// artifact route boundary 24
// artifact route boundary 25
// artifact route boundary 26
// artifact route boundary 27
// artifact route boundary 28
// artifact route boundary 29
// artifact route boundary 30
// artifact route boundary 31
// artifact route boundary 32
// artifact route boundary 33
// artifact route boundary 34
// artifact route boundary 35
// artifact route boundary 36
// artifact route boundary 37
// artifact route boundary 38
// artifact route boundary 39
// artifact route boundary 40
// artifact route boundary 41
// artifact route boundary 42
// artifact route boundary 43
// artifact route boundary 44
// artifact route boundary 45
// artifact route boundary 46
// artifact route boundary 47
// artifact route boundary 48
// artifact route boundary 49
// artifact route boundary 50
// artifact route boundary 51
// artifact route boundary 52
// artifact route boundary 53
// artifact route boundary 54
// artifact route boundary 55
// artifact route boundary 56
// artifact route boundary 57
// artifact route boundary 58
// artifact route boundary 59
// artifact route boundary 60
// artifact route boundary 61
// artifact route boundary 62
// artifact route boundary 63
// artifact route boundary 64
// artifact route boundary 65
