import { createReadStream, existsSync, watch, type FSWatcher } from "node:fs";
import { access, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EditableFileRegistry, type EditableFileContent } from "../app/editable-files.js";
import { GaiaController, type GaiaUiEvent, type VoiceCallInfo } from "../app/gaia-controller.js";
import { buildFileHints, readModelCatalog, sdkThinkingLevels, sdkToolNames, type FileHints, type HintSources } from "../app/settings-hints.js";
import {
  classifyVoiceTurn,
  completionChunk,
  completionDone,
  completionPayload,
  isStreamingRequest,
  modelListPayload,
  newCompletionId,
} from "../app/voice-bridge.js";
import { ensureVoiceSettingsFile, readVoiceSettings, type VoiceSettings } from "../app/voice-settings.js";
import { VoiceStackManager } from "../app/voice-stack.js";
import { WorkspaceRegistry, type WorkspaceRecord } from "../app/workspace-registry.js";
import { KNOWN_RUNTIMES } from "../runtime/runtime-factory.js";
import { gaiaHome, loadWorkspace, workspacePath } from "../workspace/workspace-loader.js";
import type { Workspace } from "../workspace/types.js";

interface WebServerOptions {
  cwd: string;
  host?: string;
  port?: number;
  dev?: boolean;
}

interface Client {
  id: string;
  workspaceId?: string;
  roomId?: string;
  response: ServerResponse;
}

interface DevClient {
  response: ServerResponse;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function parseBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isWebUrl(target: string): boolean {
  return /^https?:\/\//i.test(target) || /^www\./i.test(target);
}

function normalizeUrl(target: string): string {
  return /^www\./i.test(target) ? `https://${target}` : target;
}

async function existingPathCandidate(path: string): Promise<string> {
  const candidates = [path];
  const withoutLine = path.replace(/:(\d+)(?::\d+)?$/, "");
  if (withoutLine !== path) candidates.unshift(withoutLine);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep trying less-specific candidates before falling back to the original target.
    }
  }

  return path;
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

function encodeSse(event: GaiaUiEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function encodeNamedSse(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function webRoot(): string {
  return resolve(fileURLToPath(new URL("../../web", import.meta.url)));
}

function injectSnippet(html: string, snippet: string): string {
  return html.includes("</body>") ? html.replace("</body>", `${snippet}\n  </body>`) : `${html}\n${snippet}`;
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
  private readonly registry = new WorkspaceRegistry();
  private readonly controllers = new Map<string, GaiaController>();
  private readonly clients = new Set<Client>();
  private readonly devClients = new Set<DevClient>();
  private readonly devWatchers: FSWatcher[] = [];
  private readonly files = new EditableFileRegistry((id) => this.workspaceForId(id));
  private readonly pendingReloads = new Set<string>();
  private devReloadTimer: NodeJS.Timeout | undefined;
  // One voice call at a time; unmute's chat-completions requests bind to it.
  private activeCall: { workspaceId: string; info: VoiceCallInfo; settings: VoiceSettings } | undefined;
  private voiceStarting = false;
  private readonly voiceStack = new VoiceStackManager(join(gaiaHome(), "logs", "voice"));

  constructor(private readonly options: WebServerOptions) {}

  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    await this.registerCwdIfInitialized();
    await ensureVoiceSettingsFile();
    if (this.options.dev) await this.startDevWatchers();

    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) json(response, 500, { error: message });
        else response.end();
      });
    });

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 8787;

    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });

    return {
      url: `http://${host}:${port}/`,
      close: () =>
        new Promise<void>((resolveClose, reject) => {
          this.voiceStack.stop();
          for (const controller of this.controllers.values()) controller.dispose();
          for (const watcher of this.devWatchers) watcher.close();
          this.devWatchers.length = 0;
          if (this.devReloadTimer) clearTimeout(this.devReloadTimer);
          for (const client of this.devClients) client.response.end();
          this.devClients.clear();
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gaia.local");
    if (this.options.dev && request.method === "GET" && url.pathname === "/__dev/reload") {
      this.handleDevReload(response);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await this.handleApi(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/v1/")) {
      await this.handleOpenAi(request, response, url);
      return;
    }
    await this.serveStatic(response, url.pathname);
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method === "GET" && url.pathname === "/api/app") {
      await this.handleApp(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspaces") {
      const body = await parseBody(request);
      const path = stringField(body, "path");
      if (!path) {
        json(response, 400, { error: "Missing workspace path" });
        return;
      }
      const record = await this.registry.add(path);
      if (!record.isInitialized) {
        json(response, 400, { error: `Missing .gaia workspace. Run gaia init in ${record.path}.`, workspace: record });
        return;
      }
      await this.controllerFor(record.id);
      await this.handleApp(response, record.id);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/open-target") {
      const body = await parseBody(request);
      const rawTarget = stringField(body, "target")?.trim();
      if (!rawTarget) {
        json(response, 400, { error: "Missing target" });
        return;
      }

      const workspaceId = stringField(body, "workspaceId");
      const target = await this.resolveOpenTarget(rawTarget, workspaceId);
      await openWithSystem(target);
      json(response, 200, { target });
      return;
    }

    const snapshotMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/snapshot$/);
    if (request.method === "GET" && snapshotMatch) {
      const controller = await this.controllerFor(decodeURIComponent(snapshotMatch[1] ?? ""));
      json(response, 200, {
        snapshot: await controller.getSnapshot(),
        workspaceFiles: await this.files.listWorkspace(controller.workspaceId),
        voice: this.voiceFor(controller.workspaceId),
      });
      return;
    }

    const messageMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/messages$/);
    if (request.method === "POST" && messageMatch) {
      const controller = await this.controllerFor(decodeURIComponent(messageMatch[1] ?? ""));
      const roomId = decodeURIComponent(messageMatch[2] ?? "");
      if (roomId !== controller.roomId) {
        json(response, 404, { error: `Room not loaded: ${roomId}` });
        return;
      }
      const body = await parseBody(request);
      const textValue = stringField(body, "text");
      if (!textValue?.trim()) {
        json(response, 400, { error: "Missing message text" });
        return;
      }
      const task = await controller.sendMessage(textValue);
      json(response, 202, { task });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const controller = await this.controllerFor(decodeURIComponent(cancelMatch[1] ?? ""));
      const roomId = decodeURIComponent(cancelMatch[2] ?? "");
      if (roomId !== controller.roomId) {
        json(response, 404, { error: `Room not loaded: ${roomId}` });
        return;
      }
      json(response, 202, { task: await controller.cancelActiveTask() });
      return;
    }

    const voiceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/voice\/(start|stop)$/);
    if (request.method === "POST" && voiceMatch) {
      const workspaceId = decodeURIComponent(voiceMatch[1] ?? "");
      if (voiceMatch[2] === "start") await this.handleVoiceStart(request, response, workspaceId);
      else this.handleVoiceStop(response, workspaceId);
      return;
    }

    const thinkingMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/);
    if (request.method === "POST" && thinkingMatch) {
      await this.handleSetThinking(request, response, decodeURIComponent(thinkingMatch[1] ?? ""), decodeURIComponent(thinkingMatch[2] ?? ""));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      await this.handleEvents(response, url);
      return;
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (fileMatch && request.method === "GET") {
      const fileId = decodeURIComponent(fileMatch[1] ?? "");
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      const file = await this.files.read(fileId, workspaceId);
      json(response, 200, { file: { ...file, hints: await this.fileHints(file, workspaceId) } });
      return;
    }

    if (fileMatch && request.method === "PUT") {
      const fileId = decodeURIComponent(fileMatch[1] ?? "");
      const body = await parseBody(request);
      const content = stringField(body, "content");
      if (content === undefined) {
        json(response, 400, { error: "Missing file content" });
        return;
      }
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      const file = await this.files.write(fileId, content, workspaceId);
      await this.applySettingsChange(file.scope, workspaceId);
      this.broadcast({ type: "settings-saved", workspaceId, fileId });
      json(response, 200, { file: { ...file, hints: await this.fileHints(file, workspaceId) } });
      return;
    }

    json(response, 404, { error: "Not found" });
  }

  private async handleApp(response: ServerResponse, currentWorkspaceId?: string): Promise<void> {
    const workspaces = await this.registry.list();
    const current = currentWorkspaceId ?? workspaces.find((workspace) => workspace.isInitialized)?.id;
    const globalFiles = await this.files.listGlobal();
    json(response, 200, {
      workspaces,
      currentWorkspaceId: current,
      globalFiles,
      snapshot: current ? await (await this.controllerFor(current)).getSnapshot() : undefined,
      workspaceFiles: current ? await this.files.listWorkspace(current) : [],
      voice: this.voiceFor(current),
    });
  }

  private async handleEvents(response: ServerResponse, url: URL): Promise<void> {
    const client: Client = {
      id: `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: url.searchParams.get("workspaceId") ?? undefined,
      roomId: url.searchParams.get("roomId") ?? undefined,
      response,
    };

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write("event: ready\ndata: {}\n\n");
    this.clients.add(client);
    response.on("close", () => this.clients.delete(client));
  }

  private handleDevReload(response: ServerResponse): void {
    const client: DevClient = { response };
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(encodeNamedSse("ready", {}));
    this.devClients.add(client);
    response.on("close", () => this.devClients.delete(client));
  }

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const root = webRoot();
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const resolved = resolve(root, requested);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      text(response, 403, "Forbidden");
      return;
    }

    const path = existsSync(resolved) && (await stat(resolved)).isFile() ? resolved : join(root, "index.html");
    const headers: Record<string, string> = { "content-type": MIME[extname(path)] ?? "application/octet-stream" };
    if (this.options.dev) headers["cache-control"] = "no-store";

    if (this.options.dev && path === join(root, "index.html")) {
      response.writeHead(200, headers);
      response.end(injectSnippet(await readFile(path, "utf8"), devReloadSnippet()));
      return;
    }

    response.writeHead(200, headers);
    createReadStream(path).pipe(response);
  }

  private async controllerFor(workspaceId: string): Promise<GaiaController> {
    const existing = this.controllers.get(workspaceId);
    if (existing) return existing;

    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);
    const workspace = await loadWorkspace(record.path);
    const controller = new GaiaController({ cwd: record.path, workspaceId, workspace });
    controller.subscribe((event) => this.broadcast(event));
    await controller.init();
    this.controllers.set(workspaceId, controller);
    return controller;
  }

  // Settings files feed workspace/agent definitions that controllers cache at
  // creation. Rebuild affected controllers so saves apply without a restart:
  // a global file (agents, app config) touches every workspace; a workspace
  // file only its own. Busy controllers are rebuilt when their task ends.
  private async applySettingsChange(scope: "global" | "workspace", workspaceId?: string): Promise<void> {
    const ids = scope === "global" ? [...this.controllers.keys()] : workspaceId ? [workspaceId] : [];
    await Promise.all(ids.map((id) => this.reloadController(id)));
  }

  private async reloadController(workspaceId: string): Promise<void> {
    const controller = this.controllers.get(workspaceId);
    if (!controller) return;

    if (controller.hasActiveTask) {
      if (this.pendingReloads.has(workspaceId)) return;
      this.pendingReloads.add(workspaceId);
      const unsubscribe = controller.subscribe((event) => {
        if (event.type !== "task-end" && event.type !== "task-error") return;
        unsubscribe();
        this.pendingReloads.delete(workspaceId);
        void this.reloadController(workspaceId).catch(() => {});
      });
      return;
    }

    controller.dispose();
    this.controllers.delete(workspaceId);
    const fresh = await this.controllerFor(workspaceId);
    this.broadcast({ type: "snapshot", workspaceId, roomId: fresh.roomId, snapshot: await fresh.getSnapshot() });
  }

  private voiceFor(workspaceId: string | undefined): VoiceCallInfo | null {
    if (!workspaceId || !this.activeCall || this.activeCall.workspaceId !== workspaceId) return null;
    return this.activeCall.info;
  }

  private async handleVoiceStart(request: IncomingMessage, response: ServerResponse, workspaceId: string): Promise<void> {
    const body = await parseBody(request);
    const agentId = stringField(body, "agentId");
    const controller = await this.controllerFor(workspaceId);
    const agent = agentId ? controller.workspace.agents[agentId] : undefined;
    if (!agent) {
      json(response, 404, { error: `Unknown agent: ${agentId ?? "(missing agentId)"}` });
      return;
    }
    if (this.activeCall || this.voiceStarting) {
      json(response, 409, { error: this.activeCall ? `Voice call already active with @${this.activeCall.info.agentId}` : "A voice call is already starting" });
      return;
    }

    // Boot whatever parts of the unmute stack are not running yet, streaming
    // progress to the UI; hanging up stops them again (handleVoiceStop).
    const settings = await readVoiceSettings();
    const stackSettings = {
      unmuteUrl: settings.unmuteUrl,
      unmuteDir: settings.unmuteDir,
      autoStart: settings.autoStart,
      startTimeoutMs: settings.startTimeoutSec * 1000,
      silenceTimeoutSec: settings.speakOnSilence ? settings.silenceDelaySec : null,
    };
    this.voiceStarting = true;
    let unmuteUrl: string;
    try {
      ({ unmuteUrl } = await this.voiceStack.ensureRunning(stackSettings, this.gaiaUrl(), (message) => {
        this.broadcast({
          type: "voice-status",
          workspaceId,
          roomId: controller.roomId,
          voice: null,
          pending: { agentId: agent.id, message },
        });
      }));
    } catch (error) {
      json(response, 502, { error: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      this.voiceStarting = false;
    }

    const info: VoiceCallInfo = {
      agentId: agent.id,
      roomId: controller.roomId,
      unmuteUrl,
      ...(agent.voice ? { voice: agent.voice } : {}),
      // Voice latency: thinking defaults to off during the call and the
      // agent's configured level returns on hang-up. A manual change from
      // the composer control overrides this for the rest of the call.
      ...(settings.disableThinking ? { thinking: "off" } : {}),
      startedAt: new Date().toISOString(),
    };
    this.activeCall = { workspaceId, info, settings };
    this.broadcast({ type: "voice-status", workspaceId, roomId: controller.roomId, voice: info });
    json(response, 200, { voice: info });
  }

  private handleVoiceStop(response: ServerResponse, workspaceId: string): void {
    if (this.activeCall && this.activeCall.workspaceId === workspaceId) {
      const ended = this.activeCall;
      this.activeCall = undefined;
      this.broadcast({ type: "voice-status", workspaceId, roomId: ended.info.roomId, voice: null });
    }
    // The voice services only need to run while a call is live; this stops
    // exactly the ones GAIA spawned and leaves externally started ones alone.
    this.voiceStack.stop();
    json(response, 200, { voice: null });
  }

  private gaiaUrl(): string {
    return `http://${this.options.host ?? "127.0.0.1"}:${this.options.port ?? 8787}`;
  }

  // Changes an agent's thinking level. During a voice call with that agent
  // the change is call-scoped (reverts on hang-up); otherwise it persists to
  // agent.json and hot-applies through the normal settings-reload path.
  private async handleSetThinking(request: IncomingMessage, response: ServerResponse, workspaceId: string, agentId: string): Promise<void> {
    const body = await parseBody(request);
    const level = stringField(body, "level");
    const levels = sdkThinkingLevels();
    if (level === undefined || (level !== "" && !levels.includes(level))) {
      json(response, 400, { error: `Invalid thinking level. Use one of: ${levels.join(", ")} (or "" to unset)` });
      return;
    }

    const controller = await this.controllerFor(workspaceId);
    const agent = controller.workspace.agents[agentId];
    if (!agent) {
      json(response, 404, { error: `Unknown agent: ${agentId}` });
      return;
    }

    const call = this.activeCall;
    if (call && call.workspaceId === workspaceId && call.info.agentId === agentId) {
      if (level === "") delete call.info.thinking;
      else call.info.thinking = level;
      this.broadcast({ type: "voice-status", workspaceId, roomId: call.info.roomId, voice: call.info });
      json(response, 200, { scope: "call", thinking: level || undefined });
      return;
    }

    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await readFile(agent.configPath, "utf8")) as Record<string, unknown>;
    } catch {
      // Missing agent.json: create it with just the thinking level.
    }
    if (level === "") delete config.thinking;
    else config.thinking = level;
    const tempPath = `${agent.configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tempPath, agent.configPath);

    const rel = relative(gaiaHome(), agent.configPath);
    const scope = rel.startsWith("..") || isAbsolute(rel) ? "workspace" : "global";
    await this.applySettingsChange(scope, workspaceId);
    json(response, 200, { scope: "agent", thinking: level || undefined });
  }

  // The unmute backend speaks to GAIA as if it were an OpenAI-compatible LLM
  // server (KYUTAI_LLM_URL points here). Each voice turn arrives as a
  // chat-completions request; the reply streams back to TTS while the same
  // turn flows through the controller into the room transcript and SSE.
  private async handleOpenAi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, modelListPayload());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      await this.handleChatCompletions(request, response);
      return;
    }
    json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  private async handleChatCompletions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const call = this.activeCall;
    if (!call) {
      json(response, 503, { error: { message: "No active GAIA voice call. Start one from the GAIA web UI.", type: "unavailable" } });
      return;
    }

    const body = await parseBody(request);
    const turn = classifyVoiceTurn(body);
    if (!turn) {
      json(response, 400, { error: { message: "Request contains no user message", type: "invalid_request_error" } });
      return;
    }

    const completionId = newCompletionId();
    const streaming = isStreamingRequest(body);

    // Silence nudges disabled: answer with an empty completion so the agent
    // stays quiet instead of speaking up on its own.
    if (turn.kind === "silence" && !call.settings.speakOnSilence) {
      if (streaming) {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" });
        response.write(completionChunk(completionId, undefined, "stop"));
        response.write(completionDone());
        response.end();
        return;
      }
      json(response, 200, completionPayload(completionId, ""));
      return;
    }

    const controller = await this.controllerFor(call.workspaceId);
    await this.waitForIdle(controller);

    const task = await controller.sendMessage(turn.agentMessage, {
      targets: [call.info.agentId],
      channel: "voice",
      recordUserMessage: turn.kind === "user",
      thinking: call.info.thinking,
    });
    if (streaming) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
    }

    let reply = "";
    let settled = false;
    await new Promise<void>((resolveTurn) => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolveTurn();
      };
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === "text-delta" && event.taskId === task.id) {
          reply += event.delta;
          if (streaming) response.write(completionChunk(completionId, event.delta, null));
        }
        if ((event.type === "task-end" || event.type === "task-error") && event.task.id === task.id) finish();
      });
      // unmute aborts the request when the user interrupts the agent.
      response.on("close", () => {
        if (settled) return;
        if (controller.activeTaskId === task.id) void controller.cancelActiveTask().catch(() => {});
        finish();
      });
    });

    if (response.writableEnded) return;
    if (streaming) {
      response.write(completionChunk(completionId, undefined, "stop"));
      response.write(completionDone());
      response.end();
      return;
    }
    json(response, 200, completionPayload(completionId, reply));
  }

  // A typed text task may be running when a voice turn arrives; give it a
  // moment to finish instead of failing the spoken turn outright.
  private async waitForIdle(controller: GaiaController, timeoutMs = 20000): Promise<void> {
    if (!controller.hasActiveTask) return;
    await new Promise<void>((resolveIdle, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Room is busy with another task"));
      }, timeoutMs);
      const unsubscribe = controller.subscribe((event) => {
        if (event.type !== "task-end" && event.type !== "task-error") return;
        clearTimeout(timer);
        unsubscribe();
        resolveIdle();
      });
    });
  }

  private async fileHints(file: EditableFileContent, workspaceId?: string): Promise<FileHints | undefined> {
    if (file.kind !== "json") return undefined;

    let agentIds: string[] = [];
    let roomIds: string[] = [];
    if (workspaceId) {
      try {
        const controller = await this.controllerFor(workspaceId);
        agentIds = Object.keys(controller.workspace.agents);
        roomIds = (await controller.listRooms()).map((room) => room.id);
      } catch {
        // Hints degrade gracefully when the workspace cannot be loaded.
      }
    }

    const sources: HintSources = {
      agentIds,
      roomIds,
      runtimes: KNOWN_RUNTIMES,
      toolNames: sdkToolNames(this.options.cwd),
      thinkingLevels: sdkThinkingLevels(),
      models: readModelCatalog().models,
    };
    return buildFileHints(file, sources);
  }

  private async workspaceForId(workspaceId: string): Promise<Workspace | undefined> {
    const controller = this.controllers.get(workspaceId);
    if (controller) return controller.workspace;
    const record = await this.registry.find(workspaceId);
    if (!record?.isInitialized) return undefined;
    return loadWorkspace(record.path);
  }

  private async resolveOpenTarget(target: string, workspaceId?: string): Promise<string> {
    if (isWebUrl(target)) return normalizeUrl(target);

    const withoutFilePrefix = target.startsWith("file://") ? fileURLToPath(target) : target;
    const expanded = withoutFilePrefix.startsWith("~/") ? join(homedir(), withoutFilePrefix.slice(2)) : withoutFilePrefix;
    const base = workspaceId ? (await this.workspaceForId(workspaceId))?.rootDir : undefined;
    const path = isAbsolute(expanded) ? expanded : resolve(base ?? this.options.cwd, expanded);
    return existingPathCandidate(path);
  }

  private broadcast(event: GaiaUiEvent): void {
    for (const client of this.clients) {
      if (client.workspaceId && event.workspaceId && client.workspaceId !== event.workspaceId) continue;
      if (client.roomId && event.roomId && client.roomId !== event.roomId) continue;
      client.response.write(encodeSse(event));
    }
  }

  private async startDevWatchers(): Promise<void> {
    for (const dir of await this.directoriesUnder(webRoot())) {
      const watcher = watch(dir, (_eventType, filename) => {
        const name = String(filename ?? "").trim();
        if (!name || name === ".DS_Store") return;
        this.scheduleDevReload(name);
      });
      this.devWatchers.push(watcher);
    }
  }

  private async directoriesUnder(root: string): Promise<string[]> {
    const dirs = [root];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.push(...(await this.directoriesUnder(join(root, entry.name))));
    }
    return dirs;
  }

  private scheduleDevReload(path: string): void {
    if (this.devReloadTimer) clearTimeout(this.devReloadTimer);
    this.devReloadTimer = setTimeout(() => {
      this.devReloadTimer = undefined;
      for (const client of this.devClients) client.response.write(encodeNamedSse("reload", { path }));
    }, 60);
  }

  private async registerCwdIfInitialized(): Promise<void> {
    const cwd = resolve(this.options.cwd);
    if (existsSync(workspacePath(cwd))) await this.registry.add(cwd);
  }
}

export async function startWebServer(options: WebServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  return new GaiaWebServer(options).listen();
}
