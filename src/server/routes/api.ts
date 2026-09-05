import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandHome, globalPaths } from "../../core/paths.js";
import { newId } from "../../core/ids.js";
import { bearerToken, cookieHeader, cookieValue, json, parseBody, readRawBody, secureCookieForRequest } from "../../core/http.js";
import { parseContextDietOverrides } from "../../domain/context-diet.js";
import { redactedAccounts, removeAccount, updateAccount } from "../../domain/accounts.js";
import { authenticate, createUser, issueSessionToken, listUsers, revokeSessionToken } from "../../domain/users.js";
import { harnessSpecs, type GaiaTool } from "../../harness/spec.js";
import { agentRoster } from "../../harness/tools.js";
import { LLM_PROXY_MOUNT } from "../../services/proxy.js";
import { summonAck } from "../../services/summons.js";
import { addArchtreeRoot } from "../../services/archtree.js";
import { DEFAULT_PET_NAME, loadPet } from "../pet.js";
import { AUTH_COOKIE, beginSse, boolField, matchPath, respond, requireRoomAccess, stringField, type RouteContext } from "../route.js";
import { handleAgents } from "./agents.js";
import { handleRooms } from "./rooms.js";
import { handleMemory } from "./memory.js";
import { handleArtifacts } from "./artifacts.js";
import { handleUsage } from "./usage.js";
import { handleEditRetry } from "./edit-retry.js";
import { numberField } from "./memory.js";
import { summonCensusText } from "./usage.js";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".wasm": "application/wasm" };
const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;
async function openWithSystem(target: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  await new Promise<void>((resolveOpen, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolveOpen(); });
  });
}
async function pickDirectoryWithSystem(): Promise<string | undefined> {
  if (process.platform !== "darwin") throw new Error("Native folder picker is only available on macOS.");
  return new Promise((resolvePick, reject) => {
    const child = spawn("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a GAIA workspace folder")'], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk)); child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject); child.once("close", (code) => { const message = stderr.trim(); if (code === 0) return resolvePick(stdout.trim() || undefined); if (message.includes("User canceled") || message.includes("(-128)")) return resolvePick(undefined); reject(new Error(message || `Folder picker exited with code ${code}`)); });
  });
}
export async function handleApi(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
  if (await handleAgents(ctx)) return;
  if (await handleUsage(ctx)) return;
  if (method === "POST" && path === "/api/plugins/reload") {
    return respond(response, async () => {
      const staged = await daemon.pluginRegistry.stageReload();
      if (staged.status === "staged") await daemon.pluginRegistry.applyTurnBoundary();
      return staged;
    });
  }
    if (method === "GET" && path === "/api/app") {
      const owned = human?.workspace ? await daemon.addWorkspace(human.workspace, human.id) : undefined;
      json(response, 200, await daemon.appPayload(owned?.id, humanScope, human?.id));
      return;
    }
    // Codex-compatible pet packages live outside the web root. Resolve and
    // validate the requested package here; the browser receives only manifest
    // data and this scoped spritesheet URL, never a local filesystem path.
    if (method === "GET" && path === "/api/pet") {
      try {
        const name = url.searchParams.get("name")?.trim() || DEFAULT_PET_NAME;
        const { manifest } = await loadPet(name);
        json(response, 200, {
          pet: {
            ...manifest,
            spritesheetUrl: `/api/pet/spritesheet?name=${encodeURIComponent(name)}`,
          },
        });
      } catch (error) {
        json(response, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (method === "GET" && path === "/api/pet/spritesheet") {
      try {
        const name = url.searchParams.get("name")?.trim() || DEFAULT_PET_NAME;
        const { spritesheetFile } = await loadPet(name);
        response.writeHead(200, {
          "content-type": MIME[extname(spritesheetFile)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        createReadStream(spritesheetFile).pipe(response);
      } catch (error) {
        json(response, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // "Keep laptop awake" (Global Settings ▸ General): persist + apply
    // immediately. `enabled` off-macOS still persists the preference (inert
    // there — services/keep-awake.ts) so it takes effect if this daemon later
    // runs on a Mac.
    if (method === "POST" && path === "/api/app/keep-awake") {
      const body = await parseBody(request);
      const enabled = boolField(body, "enabled");
      return respond(response, async () => ({ keepAwake: await daemon.setKeepAwake(enabled) }));
    }
    // "Your name" (Global Settings ▸ General): the label the shared transcript
    // renderer uses for the human's own messages, in place of the anonymous
    // "user" token (services/user-name.ts). "" clears it back to that default.
    // Theme palette (Global Settings ▸ General): persisted daemon-side so every
    // client window opens on the same palette (services/theme.ts). "" clears it.
    if (method === "POST" && path === "/api/app/theme") {
      const body = await parseBody(request);
      const theme = stringField(body, "theme") ?? "";
      return respond(response, async () => ({ theme: await daemon.setTheme(theme) }));
    }
    if (method === "POST" && path === "/api/app/user-name") {
      const body = await parseBody(request);
      const name = stringField(body, "name") ?? "";
      return respond(response, async () => ({ userName: await daemon.setUserName(name) }));
    }
    if (await handleMemory(ctx)) return;
    if (await handleArtifacts(ctx)) return;
    if (
      (method === "GET" && path === "/api/harness/agents") ||
      (method === "POST" &&
        (path === "/api/harness/summon" ||
          path === "/api/harness/archtree" ||
          path === "/api/harness/recall" ||
          path === "/api/harness/dream" ||
          path === "/api/harness/resume" ||
          path === "/api/harness/summon/status" ||
          path === "/api/harness/tool-result-fetch" ||
          path === "/api/harness/context-diet" ||
          path === "/api/harness/end-conversation" ||
          path === "/api/harness/dog"))
    ) {
      return handleHarness(ctx, path);
    }
    // LLM credential proxy — dispatched before any body parsing so the request
    // stream reaches the proxy untouched.
    if (path === LLM_PROXY_MOUNT || path.startsWith(`${LLM_PROXY_MOUNT}/`)) {
      return;
    }
    return handleApiWorkspace(ctx);
}
async function handleApiWorkspace(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
if (method === "POST" && path === "/api/pick-directory") {
      try {
        json(response, 200, { path: (await pickDirectoryWithSystem()) ?? null });
      } catch (error) {
        json(response, 501, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (method === "POST" && path === "/api/workspaces") {
      const body = await parseBody(request);
      const workspacePathValue = stringField(body, "path");
      if (!workspacePathValue) return json(response, 400, { error: "Missing workspace path" });
      if (human?.workspace && (!isAbsolute(workspacePathValue) || resolve(workspacePathValue) !== human.workspace)) {
        return json(response, 403, { error: "Workspace is outside your assigned scope." });
      }
      const record = await daemon.addWorkspace(workspacePathValue, humanScope);
      json(response, 200, await daemon.appPayload(record.id, humanScope, human?.id));
      return;
    }
    // Sidebar drag-drop reorder: `ids` is the full new order for this human's
    // workspace list. Not a per-id route (it spans the whole list), so it lives
    // ahead of the parameterized-route ownership gate below.
    if (method === "POST" && path === "/api/workspaces/reorder") {
      const body = await parseBody(request);
      const ids = Array.isArray((body as { ids?: unknown }).ids)
        ? (body as { ids: unknown[] }).ids.filter((id): id is string => typeof id === "string")
        : [];
      return respond(response, () => daemon.reorderWorkspaces(ids, humanScope));
    }
    if (method === "POST" && path === "/api/open-target") {
      const body = await parseBody(request);
      const rawTarget = stringField(body, "target")?.trim();
      if (!rawTarget) return json(response, 400, { error: "Missing target" });
      const target = await resolveOpenTarget(ctx, rawTarget, stringField(body, "workspaceId"));
      await openWithSystem(target);
      json(response, 200, { target });
      return;
    }
    if (method === "GET" && path === "/api/events") {
      const owned = human?.workspace ? await daemon.addWorkspace(human.workspace, human.id) : undefined;
      const requestedWorkspaceId = url.searchParams.get("workspaceId") ?? undefined;
      if (owned && requestedWorkspaceId && requestedWorkspaceId !== owned.id) {
        return json(response, 403, { error: "Workspace is outside your assigned scope." });
      }
      const workspaceId = owned?.id ?? requestedWorkspaceId;
const roomId = url.searchParams.get("roomId") ?? undefined;
beginSse(response);
response.write(`event: ready\ndata: ${JSON.stringify({ bootId: ctx.bootId })}\n\n`);
for (const event of daemon.currentUsage()) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
if (workspaceId) {
  const bindings = { type: "pet-bindings", workspaceId, bindings: await daemon.petBindings(workspaceId) };
  response.write(`event: ${bindings.type}\ndata: ${JSON.stringify(bindings)}\n\n`);
}
ctx.registerSse(workspaceId, roomId);
return;
}
// Chat-wide transcript search (web client). ?q= the query; optional
    // ?workspace= narrows to one workspace, ?room= to one chat (in-chat search),
    // ?limit= caps results. Cross-workspace by default.
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      const owned = human?.workspace ? await daemon.addWorkspace(human.workspace, human.id) : undefined;
      const requestedWorkspaceId = url.searchParams.get("workspace")?.trim();
      if (owned && requestedWorkspaceId && requestedWorkspaceId !== owned.id) {
        return json(response, 403, { error: "Workspace is outside your assigned scope." });
      }
      const workspaceId = owned?.id ?? requestedWorkspaceId;
      const roomId = url.searchParams.get("room")?.trim();
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return respond(response, () =>
        daemon.searchChats(q, {
          ...(workspaceId ? { workspaceId } : {}),
          ...(roomId ? { roomId } : {}),
          ...(limit ? { limit } : {}),
        }),
      );
    }
    return handleApiWorkspaceRoutes(ctx);
}
async function handleApiWorkspaceRoutes(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
// Parameterized workspace routes.
    // Human user accounts (login/multi-user) — distinct from the provider
    // credential `/api/accounts` block just below. Session = signed cookie,
    // see domain/users.ts. First user ever created bootstraps with no auth
    // required; every user after that requires an existing valid session
    // (prevents an open internet-facing registration endpoint).
    if (method === "GET" && path === "/api/auth/me") {
      if (!human && cookieValue(request, AUTH_COOKIE)) return json(response, 401, { user: null, error: "Invalid or expired session." });
      return respond(response, async () => ({ user: human }));
    }
    if (method === "GET" && path === "/api/auth/users") {
      if (!human) return json(response, 401, { error: "Not logged in." });
      return respond(response, async () => ({ users: listUsers() }));
    }
    if (method === "POST" && path === "/api/auth/users") {
      const existing = listUsers();
      if (existing.length > 0 && !human) return json(response, 401, { error: "Log in before adding another user." });
      const body = await parseBody(request);
      const username = stringField(body, "username");
      const password = stringField(body, "password");
      const displayName = stringField(body, "displayName");
      if (!username?.trim() || !password) return json(response, 400, { error: "username and password required" });
      const home = stringField(body, "home");
      const workspace = stringField(body, "workspace");
      if ((home && !workspace) || (!home && workspace)) return json(response, 400, { error: "home and workspace must be configured together" });
      const ownership = home && workspace ? { home, workspace } : undefined;
      return respond(response, async () => ({ user: createUser(username, password, displayName, ownership) }));
    }
    if (method === "POST" && path === "/api/auth/login") {
      const body = await parseBody(request);
      const username = stringField(body, "username");
      const password = stringField(body, "password");
      const user = username && password ? authenticate(username, password) : null;
      if (!user) return json(response, 401, { error: "Invalid username or password." });
      const token = issueSessionToken(user.id);
      response.setHeader("Set-Cookie", cookieHeader(AUTH_COOKIE, token, 30 * 24 * 60 * 60, secureCookieForRequest(request)));
      return respond(response, async () => ({ user }));
    }
    if (method === "POST" && path === "/api/auth/logout") {
      const token = cookieValue(request, AUTH_COOKIE);
      if (token) revokeSessionToken(token);
      response.setHeader("Set-Cookie", cookieHeader(AUTH_COOKIE, "", 0, secureCookieForRequest(request)));
      return respond(response, async () => ({ ok: true }));
    }
    // Named accounts are managed directly in accounts.json.
    if (method === "GET" && path === "/api/accounts") {
      return respond(response, async () => ({
        accounts: redactedAccounts(),
        harnesses: harnessSpecs()
          .filter((s) => s.accounts)
          .map((s) => ({
            id: s.id,
            label: s.accounts?.label,
            login: Boolean(s.accounts?.login),
            // Lane E (chat-mto9n58s-bjr1): distinct from `login` above (that's
            // Charles's pseudo-tty account-CREATION flow) — this is whether a
            // room can trigger this harness's OWN interactive provider login
            // for an ALREADY-bound agent (capabilities.supportsUi, data —
            // RULE #0, only pi sets it true today). Backs Settings ▸ Accounts'
            // "Login via room" button; POST rooms/:id/login.
            uiLogin: Boolean(s.capabilities.supportsUi),
          })),
      }));
    }
    if (method === "DELETE" && (params = match(/^\/api\/accounts\/([^/]+)$/))) {
      return respond(response, async () => ({ removed: removeAccount(params![0]) }));
    }
    // Display metadata only — credentials remain write-only in accounts.json.
    if (method === "PATCH" && (params = match(/^\/api\/accounts\/([^/]+)$/))) {
      const body = await parseBody(request);
      const value = (key: "label" | "email"): string | null | undefined => {
        const raw = (body as Record<string, unknown> | undefined)?.[key];
        if (raw === null) return null;
        return typeof raw === "string" ? raw : undefined;
      };
      return respond(response, async () => {
        const account = updateAccount(params![0], { label: value("label"), email: value("email") });
        if (!account) throw new Error(`unknown account '${params![0]}'`);
        return { account: { id: account.id, harness: account.harness, ...(account.label ? { label: account.label } : {}), ...(account.email ? { email: account.email } : {}) } };
      });
    }
    return handleApiAccounts(ctx);
}
async function handleApiAccounts(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
// One ownership check covers the complete parameterized workspace route
    // table below. Legacy/shared requests can only reach unowned records;
    // assigned humans can only reach records carrying their own id.
    const workspaceRoute = path.match(/^\/api\/workspaces\/([^/]+)/);
    if (workspaceRoute) {
      const workspaceId = decodeURIComponent(workspaceRoute[1] ?? "");
      if (!(await daemon.registry.findForHuman(workspaceId, humanScope))) {
        return json(response, 403, { error: "Workspace is outside your assigned scope." });
      }
    }
    const roomRoute = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)(?:\/|$)/);
    if (roomRoute && !(method === "POST" && path.endsWith("/rooms/reorder"))) {
      if (!(await requireRoomAccess(ctx, roomRoute[0], roomRoute[1]))) return;
    }
    if (await handleRooms(ctx)) return;
    if (await handleEditRetry(ctx)) return;
    if (method === "GET" && (params = match(/^\/api\/workspaces\/([^/]+)\/snapshot$/))) {
      const service = await daemon.serviceFor(params[0]);
      if (!(await service.canAccessRoom(human?.id))) return json(response, 403, { error: "Not a member of this room." });
      json(response, 200, {
        snapshot: await service.getSnapshot(),
        workspaceFiles: await daemon.files.listWorkspace(service.workspaceId),
        voice: daemon.voiceFor(service.workspaceId),
      });
      return;
    }
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/default-agent$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId") ?? stringField(body, "id");
      if (!agentId?.trim()) return json(response, 400, { error: "Missing agent id" });
      return respond(response, () => daemon.setDefaultAgent(params![0], agentId.trim()));
    }
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/default-role$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId");
      const role = stringField(body, "role");
      if (!agentId?.trim()) return json(response, 400, { error: "Missing agentId" });
      return respond(response, () => daemon.setAgentDefaultRole(params![0], agentId.trim(), (role ?? "").trim()));
    }
    return handleApiMembership(ctx);
}
async function handleApiMembership(ctx: RouteContext): Promise<void> {
  return handleApiRoomActions(ctx);
}
async function handleApiRoomActions(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
// De-register a workspace: drops it from GAIA's recent-workspaces list and
    // tears down its resident services. Files on disk are never touched. Returns
    // the fresh app payload (a remaining workspace selected, or none).
    if (method === "DELETE" && (params = match(/^\/api\/workspaces\/([^/]+)$/))) {
      return respond(response, () => daemon.deleteWorkspace(params![0], humanScope));
    }
    // Sidebar right-click "Add/Remove favorite" — same mechanic as room
    // favorites, pins the workspace to the top of the list (see registry.list).
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/favorite$/))) {
      const favorite = ((await parseBody(request)) as { favorite?: unknown }).favorite === true;
      return respond(response, () => daemon.setWorkspaceFavorite(params![0], favorite, humanScope));
    }
    return handleApiVoice(ctx);
}
async function handleApiVoice(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/voice\/(start|stop)$/))) {
      const workspaceId = params[0];
      if (params[1] === "stop") {
        await daemon.stopVoiceCall(workspaceId);
        json(response, 200, { voice: null });
        return;
      }
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId");
      if (!agentId) return json(response, 404, { error: "Unknown agent: (missing agentId)" });
      try {
        json(response, 200, { voice: await daemon.startVoiceCall(workspaceId, agentId, ctx.boundUrl) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, message.startsWith("Unknown agent") ? 404 : message.includes("already") ? 409 : 502, { error: message });
      }
      return;
    }
    return handleApiDictation(ctx);
}
async function handleApiDictation(ctx: RouteContext): Promise<void> {
  const { request, response, url, daemon, human, humanScope } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;
  const match = (pattern: RegExp): string[] | null => matchPath(path, pattern);
  let params: string[] | null;
// Composer dictation durability: while a clip is still recording, the client
    // streams each recorder chunk here and appends it straight to disk under
    // <gaia home>/voice-clips/<clipId>.bin. This is fire-and-forget from the
    // client's side and must never gate or delay send/transcribe — a reload or
    // an STT failure can never lose audio that already made it to this route.
    if (method === "POST" && (params = match(/^\/api\/voice\/clip\/([^/]+)\/chunk$/))) {
      const clipId = params[0];
      if (!/^[a-z0-9-]{1,64}$/.test(clipId)) return json(response, 400, { error: "Invalid clipId" });
      try {
        const data = await readRawBody(request, TRANSCRIBE_MAX_BYTES);
        await mkdir(globalPaths.voiceClipsDir(), { recursive: true });
        await appendFile(join(globalPaths.voiceClipsDir(), `${clipId}.bin`), data);
        response.writeHead(204);
        response.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, 500, { error: message });
      }
      return;
    }
    // Composer dictation (voice INPUT): the recorded clip is POSTed as the bare
    // body (content-type = the recorder's MIME), transcribed by the resolved STT
    // engine (voice.json sttEngine; ?engine= / ?language= override), and the
    // text returned. Workspace-independent — it reads only global voice settings.
    if (method === "POST" && match(/^\/api\/voice\/transcribe$/)) {
      const contentType = request.headers["content-type"];
      const mime = typeof contentType === "string" && contentType.trim() ? contentType.split(";")[0].trim() : "application/octet-stream";
      const engineId = url.searchParams.get("engine")?.trim() || undefined;
      const language = url.searchParams.get("language")?.trim() || undefined;
      try {
        const data = await readRawBody(request, TRANSCRIBE_MAX_BYTES);
        if (data.length === 0) return json(response, 400, { error: "No audio to transcribe" });
        // Durability: land the complete clip on disk before transcription even
        // starts. Fire-and-forget — a slow or failing write must never delay
        // (or gate) the transcribe path the user is waiting on.
        const finalExt = mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : mime.includes("wav") ? "wav" : "bin";
        void mkdir(globalPaths.voiceClipsDir(), { recursive: true })
          .then(() => writeFile(join(globalPaths.voiceClipsDir(), `final-${Date.now()}.${finalExt}`), data))
          .catch(() => {});
        const result = await daemon.transcribe({ data, contentType: mime }, { engineId, language });
        return json(response, 200, { text: result.text, engine: result.engine });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(response, message.startsWith("Unknown STT engine") || message.startsWith("No audio") ? 400 : 502, { error: message });
      }
    }
    // Composer dictation (voice INPUT), durable-clip variant: transcribe a clip
    // that was already streamed to disk via the /chunk route above rather than
    // sent as one POST body. On success, archive it exactly like the plain
    // /api/voice/transcribe route (final-<ts>.<ext>) — moved there via rename
    // so the archive copy IS the preservation and the .bin is never touched on
    // failure.
    if (method === "POST" && (params = match(/^\/api\/voice\/clip\/([^/]+)\/transcribe$/))) {
      const clipId = params[0];
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(clipId)) return json(response, 400, { error: "Invalid clipId" });
      const clipPath = join(globalPaths.voiceClipsDir(), `${clipId}.bin`);
      let data: Buffer;
      try {
        data = await readFile(clipPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(response, 404, { error: "No such clip" });
        return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      if (data.length === 0) return json(response, 400, { error: "No audio to transcribe" });
      const mime = url.searchParams.get("mime")?.trim() || "audio/webm";
      const engineId = url.searchParams.get("engine")?.trim() || undefined;
      const language = url.searchParams.get("language")?.trim() || undefined;
      try {
        const result = await daemon.transcribe({ data, contentType: mime }, { engineId, language });
        const finalExt = mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : mime.includes("wav") ? "wav" : "bin";
        await mkdir(globalPaths.voiceClipsDir(), { recursive: true });
        await rename(clipPath, join(globalPaths.voiceClipsDir(), `final-${Date.now()}.${finalExt}`));
        return json(response, 200, { text: result.text, engine: result.engine });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(response, message.startsWith("Unknown STT engine") || message.startsWith("No audio") ? 400 : 502, { error: message });
      }
    }
    // Composer dictation: list clips still parked on disk (e.g. after a reload
    // interrupted transcribe/send) so the client can offer to resume or discard
    // them. Only live "<id>.bin" clips — final-*/discarded-* are archives, not
    // pending clips.
    if (method === "GET" && match(/^\/api\/voice\/clips$/)) {
      let entries: string[];
      try {
        entries = await readdir(globalPaths.voiceClipsDir());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
        else return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      const names = entries.filter(
        (name) => /^[a-z0-9][a-z0-9-]{0,63}\.bin$/.test(name) && !name.startsWith("final-") && !name.startsWith("discarded-"),
      );
      const clips = await Promise.all(
        names.map(async (name) => {
          const info = await stat(join(globalPaths.voiceClipsDir(), name));
          return { id: name.slice(0, -".bin".length), bytes: info.size, mtimeMs: info.mtimeMs };
        }),
      );
      clips.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return json(response, 200, { clips });
    }
    // Composer dictation: discard a parked clip. Never unlink — rename it out
    // of the way (discarded-<ts>-<id>.bin) so an accidental discard is still
    // recoverable from disk, same durability posture as the archive path above.
    if (method === "DELETE" && (params = match(/^\/api\/voice\/clip\/([^/]+)$/))) {
      const clipId = params[0];
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(clipId)) return json(response, 400, { error: "Invalid clipId" });
      try {
        await rename(
          join(globalPaths.voiceClipsDir(), `${clipId}.bin`),
          join(globalPaths.voiceClipsDir(), `discarded-${Date.now()}-${clipId}.bin`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(response, 404, { error: "No such clip" });
        return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if ((params = match(/^\/api\/files\/([^/]+)$/))) {
      const fileId = params[0];
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      if (workspaceId && !(await daemon.registry.findForHuman(workspaceId, humanScope))) {
        return json(response, 403, { error: "Workspace is outside your assigned scope." });
      }
      if (method === "GET") {
        const file = await daemon.files.read(fileId, workspaceId);
        json(response, 200, { file: { ...file, hints: await daemon.fileHints(file, workspaceId) } });
        return;
      }
      if (method === "PUT") {
        const body = await parseBody(request);
        const content = stringField(body, "content");
        if (content === undefined) return json(response, 400, { error: "Missing file content" });
        const file = await daemon.files.write(fileId, content, workspaceId);
        await daemon.applySettingsChange(file.scope, workspaceId);
        const pluginReload = await daemon.pluginRegistry.stageReload();
        ctx.broadcast({ type: "settings-saved", workspaceId, fileId });
        json(response, 200, { file: { ...file, hints: await daemon.fileHints(file, workspaceId) }, pluginReload });
        return;
      }
    }
    json(response, 404, { error: "Not found" });
  }
async function resolveOpenTarget(ctx: RouteContext, target: string, workspaceId?: string): Promise<string> {
  if (/^https?:\/\//i.test(target)) return target;
  if (/^www\./i.test(target)) return `https://${target}`;
  const withoutFilePrefix = target.startsWith("file://") ? fileURLToPath(target) : target;
  const expanded = expandHome(withoutFilePrefix);
  const base = workspaceId ? (await ctx.daemon.workspaceForId(workspaceId))?.rootDir : undefined;
  const path = isAbsolute(expanded) ? expanded : resolve(base ?? ctx.cwd, expanded);
  const candidates = [path]; const withoutLine = path.replace(/:(\d+)(?::\d+)?$/, "");
  if (withoutLine !== path) candidates.unshift(withoutLine);
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* next */ } }
  return path;
}
async function handleHarness(ctx: RouteContext, pathname: string): Promise<void> {
  const { request, response, daemon } = ctx;
    const claims = daemon.verifyHarnessToken(bearerToken(request));
    if (!claims) return json(response, 401, { error: "Invalid or missing harness token." });
    let workspace;
    try {
      workspace = (await daemon.serviceFor(claims.workspaceId, claims.roomId)).workspace;
    } catch (error) {
      return json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    if (pathname === "/api/harness/agents") {
      return json(response, 200, { agents: agentRoster(workspace) });
    }
    const verb = pathname.slice("/api/harness/".length).split("/")[0] as
      | "memory"
      | "summon"
      | "archtree"
      | "recall"
      | "dream"
      | "resume"
      | "tool-result-fetch"
      | "context-diet"
      | "end-conversation"
      | "dog"
      | "tools";
    // tool-result-fetch/context-diet are VERBS of the unified `gaia` tool
    // (09-MEMORY-CONTEXT), not separate GaiaTool ids like memory/summon/recall
    // — gated on the "gaia" grant itself, mirroring dream's own carve-out.
    // `dog` (09-DOG-MODE) is never a GaiaTool grant either — same carve-out.
    if (verb !== "dream" && verb !== "dog" && verb !== "tools") {
      const gaiaToolGate: GaiaTool = verb === "tool-result-fetch" || verb === "context-diet" || verb === "end-conversation" ? "gaia" : verb === "archtree" ? "summon" : verb;
      if (!daemon.harnessGaiaTools(workspace, claims.agentId).includes(gaiaToolGate)) {
        return json(response, 403, { error: `This agent's harness does not grant the ${gaiaToolGate} tool.` });
      }
    }
    const body = await parseBody(request);
    if (pathname === "/api/harness/recall") {
      const numberField = (name: string): number | undefined => {
        const raw = (body as Record<string, unknown>)[name];
        return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : undefined;
      };
      // INSIGHT "full" tier (decree 2026-07-28): pull-based raw read of any
      // currently-incognito room, gated daemon-side on the caller's own
      // insight tier — checked before touching disk, never a widened index.
      const ghoulRoom = stringField(body, "ghoul_room")?.trim();
      if (ghoulRoom) {
        try {
          const result = await daemon.harnessGhoulRoomRead(claims, ghoulRoom, { offset: numberField("offset"), limit: numberField("limit") });
          json(response, 200, { ok: true, result, hits: [] });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // INSIGHT "full" tier: search every agent's distilled ledgers (never the
      // raw transcripts — "index the ledgers, not the transcripts").
      if ((body as Record<string, unknown>).ghoul_ledgers === true) {
        try {
          const result = await daemon.harnessGhoulLedgerSearch(claims, stringField(body, "query"));
          json(response, 200, { ok: true, result, hits: [] });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // Scroll mode (§8): a raw transcript window around a prior hit id.
      const around = numberField("around");
      if (around !== undefined) {
        const span = numberField("span");
        const offset = numberField("offset");
        try {
          const result = await daemon.harnessRecallScroll(claims, around, {
            ...(span !== undefined ? { span } : {}),
            ...(offset !== undefined ? { offset } : {}),
          });
          json(response, 200, { ok: true, result, hits: [] });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const query = stringField(body, "query")?.trim();
      if (!query) return json(response, 400, { error: "query is required" });
      try {
        const summarize = (body as Record<string, unknown>).summarize === true;
        const { result, hits } = await daemon.harnessRecall(claims, query, numberField("limit"), { summarize });
        json(response, 200, { ok: true, result, hits });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    return handleHarnessActions(ctx, pathname, claims, body);
}

async function handleHarnessActions(ctx: RouteContext, pathname: string, claims: NonNullable<ReturnType<RouteContext["daemon"]["verifyHarnessToken"]>>, body: unknown): Promise<void> {
  const { response, daemon } = ctx;
// /api/harness/dream (Dream v2) — user-triggered memory consolidation, not
    // an agent capability (see the gate skip above). `agent` is the CLI's
    // `[agent]` argument, already resolved client-side to GAIA_AGENT_ID when
    // omitted — same body-driven target-agent shape as summon below, since a
    // person may dream an agent other than the one whose turn context they
    // are borrowing the token from. No `apply` → propose (preview, applies
    // nothing); `apply` → commit the pending proposal. A missing proposal on
    // apply throws, caught below as a 400 → the CLI sees ok:false and exits
    // nonzero, same as every other harness error.
    if (pathname === "/api/harness/dream") {
      const agentId = stringField(body, "agent")?.trim() || claims.agentId;
      const apply = boolField(body, "apply");
      try {
        const result = apply ? await daemon.harnessDreamApply(claims, agentId) : await daemon.harnessDreamPropose(claims, agentId);
        json(response, 200, { ok: true, result });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/resume — send a follow-up message into an EXISTING
    // room/sub-room to resume or steer its worker (steers a running turn,
    // starts a fresh one if idle), instead of firing a brand-new summon.
    // ALWAYS fire-and-forget, mirroring summon below: this call resolves once
    // the message is kicked off, never once the turn settles.
    // `room` is scoped strictly to claims.workspaceId — serviceFor resolves it
    // against the CALLER's own workspace registry, so a caller can never reach
    // a room living in another workspace even by guessing its id.
    // Fix #1 (resume-completion tracking, gaia-daemon-triage/FIX-DESIGN.md):
    // routed through the summon coordinator so an ALREADY-delivered summon
    // child registers a durable delivery contract for THIS resumed turn —
    // when it settles, the result posts back to the parent room the SAME way
    // a first-turn summon's result does (SummonCoordinator.resume). Plain
    // rooms (no state.summon) get the exact original untracked behavior.
    if (pathname === "/api/harness/resume") {
      const room = stringField(body, "room")?.trim();
      const message = stringField(body, "message")?.trim();
      if (!room || !message) return json(response, 400, { error: "Missing room or message" });
      try {
        const service = await daemon.serviceFor(claims.workspaceId, room);
        const coordinator = await daemon.coordinatorFor(claims.workspaceId);
        const { tracked } = await coordinator.resume(room, service, message);
        json(response, 200, {
          roomId: room,
          result: `Resumed room '${room}' with a follow-up message.${tracked ? " Its result will post back to the parent room when the turn settles." : ""}`,
        });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/summon/status (Fix #2, gaia-daemon-triage/FIX-DESIGN.md) —
    // read-only census of summon lanes: state, last-event time, delivered?,
    // dirty-worktree hint. `room` scopes to that room's direct summon
    // children (default: the CALLER's own room); `all: true` lists every
    // summon lane in the workspace regardless of parent. Gated on the same
    // "summon" grant as launching one (pathname's first segment is "summon").
    if (pathname === "/api/harness/summon/status") {
      const room = stringField(body, "room")?.trim();
      const all = boolField(body, "all");
      try {
        const coordinator = await daemon.coordinatorFor(claims.workspaceId);
        const entries = await coordinator.census(all ? undefined : room || claims.roomId);
        json(response, 200, { entries, result: summonCensusText(entries) });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/tool-result-fetch (09-MEMORY-CONTEXT): pages the ORIGINAL,
    // uncollapsed call/args/result for a diet-collapsed own tool-call stub back
    // by (sessionId, entryId) — the daemon-side half of the `tool_result_fetch`
    // gaia-tool verb; scoped strictly to the CALLER's own room (claims.roomId).
    if (pathname === "/api/harness/tool-result-fetch") {
      const sessionId = stringField(body, "sessionId")?.trim();
      const entryId = stringField(body, "entryId")?.trim();
      const offset = numberField(body, "offset") ?? 0;
      const limit = numberField(body, "limit") ?? 32_000;
      if (!sessionId || !entryId) return json(response, 400, { error: "Missing sessionId or entryId" });
      if (!Number.isSafeInteger(offset) || offset < 0) return json(response, 400, { error: "offset must be non-negative" });
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 32_000) return json(response, 400, { error: "limit must be between 1 and 32000" });
      try {
        const slice = await daemon.harnessToolResultFetch(claims, sessionId, entryId, offset, limit);
        json(response, 200, { ok: true, ...slice });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/end-conversation — scoped by the bearer token to the
    // calling agent and room; the service writes the visible farewell before
    // it aborts the current runner.
    if (pathname === "/api/harness/end-conversation") {
      const farewell = stringField(body, "farewell")?.trim();
      if (!farewell) return json(response, 400, { error: "farewell is required" });
      try {
        json(response, 200, { ok: true, result: await daemon.harnessEndConversation(claims, farewell) });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/dog (09-DOG-MODE): `gaia dog on|off|status`, the CLI form
    // of `/dog` — daemon-side half is RoomService#runPluginAction (the dog
    // command-plugin, plugins/defaults/dog-mode.mjs), same room the bearer
    // token names (no cross-room targeting from this endpoint).
    if (pathname === "/api/harness/dog") {
      const sub = stringField(body, "sub");
      if (sub !== "on" && sub !== "off" && sub !== "status") return json(response, 400, { error: "sub must be on|off|status" });
      try {
        const text = await daemon.harnessDogCommand(claims, sub);
        json(response, 200, { ok: true, result: text });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/context-diet (09-MEMORY-CONTEXT): read/patch the calling
    // room's context-diet policy — the daemon-side half of BOTH the `diet`
    // gaia-tool verb and the `/diet` room command (one implementation).
    // `{}` (no `patch`/`scope`) is a read; a `patch` present is a write.
    if (pathname === "/api/harness/context-diet") {
      const rawPatch = (body as Record<string, unknown>).patch;
      const scope = stringField(body, "scope") === "workspace" ? "workspace" : "room";
      try {
        if (rawPatch === undefined) {
          json(response, 200, { ok: true, ...(await daemon.harnessContextDietGet(claims)) });
          return;
        }
        const patch = parseContextDietOverrides(rawPatch);
        json(response, 200, { ok: true, ...(await daemon.harnessContextDietSet(claims, scope, patch)) });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/archtree — independent root under the calling coordinator.
    // It reuses SummonCoordinator: parent link, durable delivery, recovery and
    // heartbeat/cap semantics remain exactly the ordinary summon path.
    if (pathname === "/api/harness/archtree") {
      if (!claims.allowSummon) return json(response, 403, { error: "Summoned agents cannot summon." });
      const agentId = stringField(body, "agent")?.trim() || claims.agentId;
      const task = stringField(body, "task")?.trim();
      if (!task) return json(response, 400, { error: "Missing root task" });
      try {
        const coordinator = await daemon.coordinatorFor(claims.workspaceId);
        const workspace = await daemon.workspaceForId(claims.workspaceId);
        if (!workspace) throw new Error("Archtree workspace unavailable");
        const roomId = await addArchtreeRoot(coordinator, { workspace, parentRoomId: claims.roomId, agentId, task, callerAgentId: claims.agentId });
        json(response, 200, { roomId, result: `Added archtree root @${agentId} in room '${roomId}'.` });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // /api/harness/summon — ALWAYS fire-and-forget, for every harness and every
    // transport: the caller's turn never blocks on a worker. The worker runs in
    // its own sub-room (nested in the sidebar, watchable live); when it settles,
    // the coordinator posts its result back into the calling room and queues a
    // turn for the calling agent — the subagent callback, durable across
    // restarts. (The old `wait: true` blocking mode is gone: it froze the
    // calling room for the whole worker run.)
    if (!claims.allowSummon) return json(response, 403, { error: "Summoned agents cannot summon." });
    const targetAgent = stringField(body, "agent") ?? stringField(body, "agentId");
    const task = stringField(body, "task");
    if (!targetAgent || !task?.trim()) return json(response, 400, { error: "Missing agent or task" });
    try {
      const coordinator = await daemon.coordinatorFor(claims.workspaceId);
      const roomId = await coordinator.summon(claims.roomId, targetAgent, task.trim(), {
        deliver: "turn",
        callerAgentId: claims.agentId,
        ownWorktree: boolField(body, "ownWorktree"),
      });
      json(response, 200, { roomId, result: summonAck(targetAgent, roomId) });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }