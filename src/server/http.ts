// The HTTP surface: routes → daemon calls, SSE fan-out, static files, and the
// OpenAI-compatible voice endpoints. No business logic lives here — if a
// handler grows past parsing and delegating, it belongs on the Daemon.

import { createReadStream, existsSync, watch, type FSWatcher } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gaiaHost, gaiaPort } from "../core/config.js";
import { newId } from "../core/ids.js";
import { bearerToken, json, parseBody, text } from "../core/http.js";
import type { UiEvent } from "../core/types.js";
import type { MemoryAction } from "../domain/memory.js";
import { scaffoldGlobalAgent } from "../domain/agents.js";
import { globalAgentsPath } from "../domain/workspace.js";
import { Daemon } from "../daemon.js";
import { forwardLlmRequest, LLM_PROXY_MOUNT, llmProxySubpath } from "../services/proxy.js";
import { completionChunk, completionDone, completionPayload, isStreamingRequest, modelListPayload, newCompletionId } from "../services/voice.js";

export interface WebServerOptions {
  cwd: string;
  host?: string;
  port?: number;
  dev?: boolean;
}

interface SseClient {
  id: string;
  workspaceId?: string;
  roomId?: string;
  response: ServerResponse;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
};

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function titleCaseId(id: string): string {
  return (
    id
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || id
  );
}

function encodeSse(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function webRoot(): string {
  return resolve(fileURLToPath(new URL("../../web", import.meta.url)));
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function openWithSystem(target: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  await new Promise<void>((resolveOpen, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveOpen();
    });
  });
}

async function pickDirectoryWithSystem(): Promise<string | undefined> {
  if (process.platform !== "darwin") throw new Error("Native folder picker is only available on macOS.");
  return new Promise((resolvePick, reject) => {
    const child = spawn("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a GAIA workspace folder")'], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const message = stderr.trim();
      if (code === 0) return resolvePick(stdout.trim() || undefined);
      if (message.includes("User canceled") || message.includes("(-128)")) return resolvePick(undefined);
      reject(new Error(message || `Folder picker exited with code ${code}`));
    });
  });
}

function devReloadSnippet(): string {
  return `<script>
(() => {
  if (window.__gaiaDevReload) return;
  window.__gaiaDevReload = true;
  let hadConnection = false;
  let reconnectAfterDrop = false;
  const source = new EventSource("/__dev/reload");
  source.addEventListener("ready", () => {
    if (hadConnection && reconnectAfterDrop) window.location.reload();
    hadConnection = true;
    reconnectAfterDrop = false;
  });
  source.addEventListener("reload", () => window.location.reload());
  source.onerror = () => {
    if (hadConnection) reconnectAfterDrop = true;
  };
})();
</script>`;
}

export class GaiaWebServer {
  private readonly daemon: Daemon;
  private readonly clients = new Set<SseClient>();
  private readonly devClients = new Set<ServerResponse>();
  private readonly devWatchers: FSWatcher[] = [];
  private devReloadTimer: NodeJS.Timeout | undefined;
  private boundUrl = "";

  constructor(private readonly options: WebServerOptions) {
    this.daemon = new Daemon({ cwd: options.cwd });
    this.daemon.subscribe((event) => this.broadcast(event));
  }

  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    if (this.options.dev) await this.startDevWatchers();

    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) json(response, 500, { error: message });
        else response.end();
      });
    });

    const host = this.options.host ?? gaiaHost();
    const port = this.options.port ?? gaiaPort();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });

    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    this.boundUrl = `http://${host}:${boundPort}`;
    await this.daemon.boot(this.boundUrl);

    return {
      url: `${this.boundUrl}/`,
      close: () =>
        new Promise<void>((resolveClose, reject) => {
          this.daemon.dispose();
          for (const watcher of this.devWatchers) watcher.close();
          this.devWatchers.length = 0;
          if (this.devReloadTimer) clearTimeout(this.devReloadTimer);
          for (const client of this.devClients) client.end();
          this.devClients.clear();
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gaia.local");
    if (this.options.dev && request.method === "GET" && url.pathname === "/__dev/reload") {
      beginSse(response);
      response.write(encodeSse("ready", {}));
      this.devClients.add(response);
      response.on("close", () => this.devClients.delete(response));
      return;
    }
    if (url.pathname.startsWith("/api/")) return this.handleApi(request, response, url);
    if (url.pathname.startsWith("/v1/")) return this.handleOpenAi(request, response, url);
    await this.serveStatic(response, url.pathname);
  }

  // --- /api ---------------------------------------------------------------------

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/api/app") {
      json(response, 200, await this.daemon.appPayload());
      return;
    }

    if (method === "POST" && (path === "/api/harness/memory" || path === "/api/harness/summon")) {
      return this.handleHarness(request, response, path);
    }

    // LLM credential proxy — dispatched before any body parsing so the request
    // stream reaches the proxy untouched.
    if (path === LLM_PROXY_MOUNT || path.startsWith(`${LLM_PROXY_MOUNT}/`)) {
      return this.handleLlmProxy(request, response, url);
    }

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
      const record = await this.daemon.addWorkspace(workspacePathValue);
      json(response, 200, await this.daemon.appPayload(record.id));
      return;
    }

    if (method === "POST" && path === "/api/agents") {
      const body = await parseBody(request);
      const id = stringField(body, "id");
      if (!id) return json(response, 400, { error: "Missing agent id" });
      try {
        const displayName = stringField(body, "displayName")?.trim() || titleCaseId(id);
        const result = await scaffoldGlobalAgent(globalAgentsPath(), id, { displayName, icon: stringField(body, "icon") });
        await this.daemon.applySettingsChange("global");
        json(response, 201, { agent: { id, displayName, dir: result.agentDir } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, message.startsWith("Invalid agent id") ? 400 : 409, { error: message });
      }
      return;
    }

    if (method === "POST" && path === "/api/open-target") {
      const body = await parseBody(request);
      const rawTarget = stringField(body, "target")?.trim();
      if (!rawTarget) return json(response, 400, { error: "Missing target" });
      const target = await this.resolveOpenTarget(rawTarget, stringField(body, "workspaceId"));
      await openWithSystem(target);
      json(response, 200, { target });
      return;
    }

    if (method === "GET" && path === "/api/events") {
      const client: SseClient = {
        id: newId("client"),
        workspaceId: url.searchParams.get("workspaceId") ?? undefined,
        roomId: url.searchParams.get("roomId") ?? undefined,
        response,
      };
      beginSse(response);
      response.write(encodeSse("ready", {}));
      this.clients.add(client);
      response.on("close", () => this.clients.delete(client));
      return;
    }

    // Parameterized workspace routes.
    const match = (pattern: RegExp): string[] | null => {
      const result = path.match(pattern);
      return result ? result.slice(1).map((part) => decodeURIComponent(part ?? "")) : null;
    };

    let params: string[] | null;

    if (method === "GET" && (params = match(/^\/api\/workspaces\/([^/]+)\/snapshot$/))) {
      const service = await this.daemon.serviceFor(params[0]);
      json(response, 200, {
        snapshot: await service.getSnapshot(),
        workspaceFiles: await this.daemon.files.listWorkspace(service.workspaceId),
        voice: this.daemon.voiceFor(service.workspaceId),
      });
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms$/))) {
      const body = await parseBody(request);
      const roomId = stringField(body, "roomId") ?? stringField(body, "id") ?? stringField(body, "room");
      if (!roomId?.trim()) return json(response, 400, { error: "Missing room id" });
      return this.respond(response, () => this.daemon.selectRoom(params![0], roomId.trim()));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(?:select|activate)$/))) {
      return this.respond(response, () => this.daemon.selectRoom(params![0], params![1]));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/default-agent$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId") ?? stringField(body, "id");
      if (!agentId?.trim()) return json(response, 400, { error: "Missing agent id" });
      return this.respond(response, () => this.daemon.setDefaultAgent(params![0], agentId.trim()));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/role$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId");
      const role = stringField(body, "role");
      if (!agentId?.trim() || !role?.trim()) return json(response, 400, { error: "Missing agentId or role" });
      return this.respond(response, () => this.daemon.setAgentRole(params![0], params![1], agentId.trim(), role.trim()));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/messages$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const body = await parseBody(request);
      const textValue = stringField(body, "text");
      if (!textValue?.trim()) return json(response, 400, { error: "Missing message text" });
      const task = await service.sendMessage(textValue);
      json(response, 202, { task });
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/summons$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId") ?? stringField(body, "agent");
      const taskText = stringField(body, "task");
      if (!agentId || !taskText?.trim()) return json(response, 400, { error: "Missing agentId or task" });
      try {
        const coordinator = await this.daemon.coordinatorFor(params[0]);
        const childRoomId = await coordinator.summon(params[1], agentId, taskText.trim());
        json(response, 202, { roomId: childRoomId });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/cancel$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      json(response, 202, { task: await service.cancelActiveTask() });
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/voice\/(start|stop)$/))) {
      const workspaceId = params[0];
      if (params[1] === "stop") {
        await this.daemon.stopVoiceCall(workspaceId);
        json(response, 200, { voice: null });
        return;
      }
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId");
      if (!agentId) return json(response, 404, { error: "Unknown agent: (missing agentId)" });
      try {
        json(response, 200, { voice: await this.daemon.startVoiceCall(workspaceId, agentId, this.boundUrl) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, message.startsWith("Unknown agent") ? 404 : message.includes("already") ? 409 : 502, { error: message });
      }
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/))) {
      const body = await parseBody(request);
      const level = stringField(body, "level");
      if (level === undefined) return json(response, 400, { error: "Missing thinking level" });
      try {
        const result = await this.daemon.applyThinking(params[0], params[1], level);
        json(response, 200, { scope: result.scope, thinking: level || undefined });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if ((params = match(/^\/api\/files\/([^/]+)$/))) {
      const fileId = params[0];
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      if (method === "GET") {
        const file = await this.daemon.files.read(fileId, workspaceId);
        json(response, 200, { file: { ...file, hints: await this.daemon.fileHints(file, workspaceId) } });
        return;
      }
      if (method === "PUT") {
        const body = await parseBody(request);
        const content = stringField(body, "content");
        if (content === undefined) return json(response, 400, { error: "Missing file content" });
        const file = await this.daemon.files.write(fileId, content, workspaceId);
        await this.daemon.applySettingsChange(file.scope, workspaceId);
        this.broadcast({ type: "settings-saved", workspaceId, fileId });
        json(response, 200, { file: { ...file, hints: await this.daemon.fileHints(file, workspaceId) } });
        return;
      }
    }

    json(response, 404, { error: "Not found" });
  }

  private async respond(response: ServerResponse, run: () => Promise<unknown>): Promise<void> {
    try {
      json(response, 200, await run());
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Memory writes and summon for harness subprocesses (the `gaia` CLI). The
  // bearer token resolves the (workspace, agent, room), so the body cannot
  // spoof identity; the verb is capability-gated against the harness registry.
  private async handleHarness(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const claims = this.daemon.verifyHarnessToken(bearerToken(request));
    if (!claims) return json(response, 401, { error: "Invalid or missing harness token." });

    let workspace;
    try {
      workspace = (await this.daemon.serviceFor(claims.workspaceId, claims.roomId)).workspace;
    } catch (error) {
      return json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }

    const verb = pathname.slice("/api/harness/".length).split("/")[0] as "memory" | "summon";
    if (!this.daemon.harnessGaiaTools(workspace, claims.agentId).includes(verb)) {
      return json(response, 403, { error: `This agent's harness does not grant the ${verb} tool.` });
    }

    const body = await parseBody(request);

    if (pathname === "/api/harness/memory") {
      const action = stringField(body, "action") as MemoryAction | undefined;
      if (action !== "add" && action !== "replace" && action !== "remove") {
        return json(response, 400, { error: "action must be add, replace, or remove" });
      }
      try {
        const result = await this.daemon.harnessMemoryWrite(claims, stringField(body, "file") ?? "MEMORY.md", action, {
          content: stringField(body, "content"),
          oldText: stringField(body, "old_text"),
        });
        const head = `${result.ok ? "OK" : "ERROR"}: ${result.message}`;
        json(response, 200, { result: result.ok ? `${head}\n\n${result.state.content}` : head, ok: result.ok, message: result.message });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // /api/harness/summon
    if (!claims.allowSummon) return json(response, 403, { error: "Summoned agents cannot summon." });
    const targetAgent = stringField(body, "agent") ?? stringField(body, "agentId");
    const task = stringField(body, "task");
    if (!targetAgent || !task?.trim()) return json(response, 400, { error: "Missing agent or task" });
    try {
      const coordinator = await this.daemon.coordinatorFor(claims.workspaceId);
      json(response, 200, { result: await coordinator.summonAndWait(claims.roomId, targetAgent, task.trim()) });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleLlmProxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const claims = this.daemon.verifyHarnessToken(bearerToken(request));
    if (!claims) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("llm proxy: invalid or missing harness token");
      return;
    }
    const upstream = await this.daemon.resolveProxyUpstream(claims);
    if (!upstream) {
      // Fail-closed: no resolvable credential → refuse rather than leak/guess.
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("llm proxy: no resolvable upstream credential for this agent");
      return;
    }
    await forwardLlmRequest(request, response, upstream, llmProxySubpath(url.pathname, url.search));
  }

  // --- /v1 (the unmute backend speaks to GAIA as an OpenAI-compatible server) -----

  private async handleOpenAi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, modelListPayload());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return this.handleChatCompletions(request, response);
    }
    json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  private async handleChatCompletions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const call = this.daemon.activeCall;
    if (!call) {
      json(response, 503, { error: { message: "No active GAIA voice call. Start one from the GAIA web UI.", type: "unavailable" } });
      return;
    }

    const body = await parseBody(request);
    const turn = this.daemon.classifyTurn(body);
    if (!turn) {
      json(response, 400, { error: { message: "Request contains no user message", type: "invalid_request_error" } });
      return;
    }

    const completionId = newCompletionId();
    const streaming = isStreamingRequest(body);

    // Silence nudges disabled: answer empty so the agent stays quiet.
    if (turn.kind === "silence" && !call.settings.speakOnSilence) {
      if (streaming) {
        beginSse(response);
        this.endCompletionStream(response, completionId);
        return;
      }
      json(response, 200, completionPayload(completionId, ""));
      return;
    }

    const service = await this.daemon.serviceFor(call.workspaceId, call.info.roomId);
    // A typed text task may be running; give it a moment instead of failing
    // the spoken turn outright.
    await service.waitForIdle(20000);

    const task = await service.sendMessage(turn.agentMessage, {
      targets: [call.info.agentId],
      channel: "voice",
      recordUserMessage: turn.kind === "user",
      thinking: call.info.thinking,
    });
    if (streaming) beginSse(response);

    let reply = "";
    let settled = false;
    await new Promise<void>((resolveTurn) => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolveTurn();
      };
      const unsubscribe = service.subscribe((event) => {
        if (event.type === "text-delta" && event.taskId === task.id) {
          reply += event.delta;
          if (streaming) response.write(completionChunk(completionId, event.delta, null));
        }
        if ((event.type === "task-end" || event.type === "task-error") && event.task.id === task.id) finish();
      });
      // unmute aborts the request when the user interrupts the agent.
      response.on("close", () => {
        if (settled) return;
        if (service.activeTaskId === task.id) void service.cancelActiveTask().catch(() => {});
        finish();
      });
    });

    if (response.writableEnded) return;
    if (streaming) return this.endCompletionStream(response, completionId);
    json(response, 200, completionPayload(completionId, reply));
  }

  private endCompletionStream(response: ServerResponse, completionId: string): void {
    response.write(completionChunk(completionId, undefined, "stop"));
    response.write(completionDone());
    response.end();
  }

  // --- static ---------------------------------------------------------------------

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const root = webRoot();
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const resolved = resolve(root, requested);
    if (!pathInside(resolved, root)) return text(response, 403, "Forbidden");

    const path = existsSync(resolved) && (await stat(resolved)).isFile() ? resolved : join(root, "index.html");
    const headers: Record<string, string> = { "content-type": MIME[extname(path)] ?? "application/octet-stream" };
    if (this.options.dev) headers["cache-control"] = "no-store";

    if (this.options.dev && path === join(root, "index.html")) {
      const html = await readFile(path, "utf8");
      response.writeHead(200, headers);
      response.end(html.includes("</body>") ? html.replace("</body>", `${devReloadSnippet()}\n  </body>`) : `${html}\n${devReloadSnippet()}`);
      return;
    }

    response.writeHead(200, headers);
    createReadStream(path).pipe(response);
  }

  private async resolveOpenTarget(target: string, workspaceId?: string): Promise<string> {
    if (/^https?:\/\//i.test(target)) return target;
    if (/^www\./i.test(target)) return `https://${target}`;

    const withoutFilePrefix = target.startsWith("file://") ? fileURLToPath(target) : target;
    const expanded = withoutFilePrefix.startsWith("~/") ? join(homedir(), withoutFilePrefix.slice(2)) : withoutFilePrefix;
    const base = workspaceId ? (await this.daemon.workspaceForId(workspaceId))?.rootDir : undefined;
    const path = isAbsolute(expanded) ? expanded : resolve(base ?? this.options.cwd, expanded);

    // Prefer the path without a trailing :line(:col) suffix when that file exists.
    const candidates = [path];
    const withoutLine = path.replace(/:(\d+)(?::\d+)?$/, "");
    if (withoutLine !== path) candidates.unshift(withoutLine);
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next, less-specific candidate.
      }
    }
    return path;
  }

  // --- SSE fan-out -------------------------------------------------------------------

  private broadcast(event: UiEvent): void {
    const payload = encodeSse(event.type, event);
    for (const client of this.clients) {
      const scoped = event as { workspaceId?: string; roomId?: string };
      if (client.workspaceId && scoped.workspaceId && client.workspaceId !== scoped.workspaceId) continue;
      if (client.roomId && scoped.roomId && client.roomId !== scoped.roomId) continue;
      client.response.write(payload);
    }
  }

  private async startDevWatchers(): Promise<void> {
    const root = webRoot();
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const dirs = [root, ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name))];
    for (const dir of dirs) {
      const watcher = watch(dir, (_eventType, filename) => {
        const name = String(filename ?? "").trim();
        if (!name || name === ".DS_Store") return;
        if (this.devReloadTimer) clearTimeout(this.devReloadTimer);
        this.devReloadTimer = setTimeout(() => {
          this.devReloadTimer = undefined;
          for (const client of this.devClients) client.write(encodeSse("reload", { path: name }));
        }, 60);
      });
      this.devWatchers.push(watcher);
    }
  }
}

export async function startWebServer(options: WebServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  return new GaiaWebServer(options).listen();
}
