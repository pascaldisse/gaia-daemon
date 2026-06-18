import { createReadStream, existsSync, watch, type FSWatcher } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EditableFileRegistry, type EditableFileContent, type EditableFileDescriptor } from "../app/editable-files.js";
import { GaiaController, type GaiaUiEvent, type VoiceCallInfo } from "../app/gaia-controller.js";
import { HarnessBridge } from "../app/harness-bridge.js";
import type { MemoryAction } from "../memory/memory-store.js";
import { buildFileHints, readModelCatalog, sdkThinkingLevels, sdkToolNames, type FileHints, type HintSources, type ModelChoice } from "../app/settings-hints.js";
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
import { WorkspaceRegistry } from "../app/workspace-registry.js";
import { pathInside } from "../lib/fs.js";
import { newId } from "../lib/ids.js";
import { scaffoldGlobalAgent } from "../agents/scaffold.js";
import { ensureWorkspaceRoom, gaiaHome, globalAgentsPath, loadWorkspace, setWorkspaceRoom, workspacePath } from "../workspace/workspace-loader.js";
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

function titleCaseId(id: string): string {
  return (
    id
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || id
  );
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
      if (code === 0) {
        resolvePick(stdout.trim() || undefined);
        return;
      }
      if (message.includes("User canceled") || message.includes("(-128)")) {
        resolvePick(undefined);
        return;
      }
      reject(new Error(message || `Folder picker exited with code ${code}`));
    });
  });
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
  // Process-stable settings-hint sources, invalidated on settings saves.
  private hintSourcesCache: { toolNames: string[]; models: ModelChoice[] } | undefined;
  // Bridges harness subprocesses to memory-write/summon endpoints; created once
  // the server is bound so the token URL points at the real port.
  private harnessBridge: HarnessBridge | undefined;

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

    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    this.harnessBridge = new HarnessBridge(`http://${host}:${boundPort}`);

    return {
      url: `http://${host}:${boundPort}/`,
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

    if (request.method === "POST" && (url.pathname === "/api/harness/memory" || url.pathname === "/api/harness/summon")) {
      await this.handleHarness(request, response, url.pathname);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pick-directory") {
      try {
        json(response, 200, { path: (await pickDirectoryWithSystem()) ?? null });
      } catch (error) {
        json(response, 501, { error: error instanceof Error ? error.message : String(error) });
      }
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

    if (request.method === "POST" && url.pathname === "/api/agents") {
      const body = await parseBody(request);
      const id = stringField(body, "id");
      if (!id) {
        json(response, 400, { error: "Missing agent id" });
        return;
      }
      try {
        const displayName = stringField(body, "displayName")?.trim() || titleCaseId(id);
        const result = await scaffoldGlobalAgent(globalAgentsPath(), id, {
          displayName,
          icon: stringField(body, "icon"),
        });
        await this.applySettingsChange("global");
        json(response, 201, { agent: { id, displayName, dir: result.agentDir } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, message.startsWith("Invalid agent id") ? 400 : 409, { error: message });
      }
      return;
    }

    const createRoomMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms$/);
    if (request.method === "POST" && createRoomMatch) {
      const body = await parseBody(request);
      const roomId = stringField(body, "roomId") ?? stringField(body, "id") ?? stringField(body, "room");
      if (!roomId?.trim()) {
        json(response, 400, { error: "Missing room id" });
        return;
      }
      try {
        json(response, 200, await this.selectWorkspaceRoom(decodeURIComponent(createRoomMatch[1] ?? ""), roomId.trim()));
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const selectRoomMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(?:select|activate)$/);
    if (request.method === "POST" && selectRoomMatch) {
      try {
        json(response, 200, await this.selectWorkspaceRoom(decodeURIComponent(selectRoomMatch[1] ?? ""), decodeURIComponent(selectRoomMatch[2] ?? "")));
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
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

    const summonsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/summons$/);
    if (summonsMatch) {
      const controller = await this.controllerFor(decodeURIComponent(summonsMatch[1] ?? ""));
      const roomId = decodeURIComponent(summonsMatch[2] ?? "");
      if (roomId !== controller.roomId) {
        json(response, 404, { error: `Room not loaded: ${roomId}` });
        return;
      }
      const manager = controller.summonManager;
      if (!manager) {
        json(response, 501, { error: "Summon system is not available." });
        return;
      }

      if (request.method === "GET") {
        json(response, 200, { summons: await manager.listStored(roomId) });
        return;
      }
      if (request.method === "POST") {
        const body = await parseBody(request);
        const agentId = stringField(body, "agentId") ?? stringField(body, "agent");
        const taskText = stringField(body, "task");
        if (!agentId || !taskText?.trim()) {
          json(response, 400, { error: "Missing agentId or task" });
          return;
        }
        try {
          json(response, 202, { session: await manager.create(roomId, agentId, taskText.trim()) });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
    }

    const summonMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/summons\/([^/]+)$/);
    if (request.method === "GET" && summonMatch) {
      const controller = await this.controllerFor(decodeURIComponent(summonMatch[1] ?? ""));
      const roomId = decodeURIComponent(summonMatch[2] ?? "");
      if (roomId !== controller.roomId) {
        json(response, 404, { error: `Room not loaded: ${roomId}` });
        return;
      }
      const details = await controller.summonManager?.details(roomId, decodeURIComponent(summonMatch[3] ?? ""));
      if (!details) {
        json(response, 404, { error: "Summon not found" });
        return;
      }
      json(response, 200, details);
      return;
    }

    const summonCancelMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/summons\/([^/]+)\/cancel$/);
    if (request.method === "POST" && summonCancelMatch) {
      const controller = await this.controllerFor(decodeURIComponent(summonCancelMatch[1] ?? ""));
      const roomId = decodeURIComponent(summonCancelMatch[2] ?? "");
      if (roomId !== controller.roomId) {
        json(response, 404, { error: `Room not loaded: ${roomId}` });
        return;
      }
      const session = await controller.summonManager?.cancel(decodeURIComponent(summonCancelMatch[3] ?? ""));
      if (!session) {
        json(response, 404, { error: "Running summon not found" });
        return;
      }
      json(response, 202, { session });
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

  // Memory writes and summon for harness subprocesses (the `gaia` CLI). The
  // bearer token (minted per turn, see HarnessBridge) resolves the (workspace,
  // agent, room) the request acts on, so the body cannot spoof identity.
  private async handleHarness(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const claims = this.harnessBridge?.verify(token);
    if (!claims) {
      json(response, 401, { error: "Invalid or missing harness token." });
      return;
    }

    let controller: GaiaController;
    try {
      controller = await this.controllerFor(claims.workspaceId);
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const body = await parseBody(request);

    if (pathname === "/api/harness/memory") {
      const action = stringField(body, "action") as MemoryAction | undefined;
      if (action !== "add" && action !== "replace" && action !== "remove") {
        json(response, 400, { error: "action must be add, replace, or remove" });
        return;
      }
      try {
        const result = await controller.mutateAgentMemory(claims.agentId, stringField(body, "file") ?? "MEMORY.md", action, {
          content: stringField(body, "content"),
          oldText: stringField(body, "old_text"),
        });
        const head = `${result.ok ? "OK" : "ERROR"}: ${result.message}`;
        json(response, 200, { result: result.ok ? `${head}\n\n${result.state.content}` : head });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // /api/harness/summon
    if (!claims.allowSummon) {
      json(response, 403, { error: "Summoned agents cannot summon." });
      return;
    }
    const targetAgent = stringField(body, "agent") ?? stringField(body, "agentId");
    const task = stringField(body, "task");
    if (!targetAgent || !task?.trim()) {
      json(response, 400, { error: "Missing agent or task" });
      return;
    }
    try {
      const result = await controller.summonAndWait(claims.roomId, targetAgent, task.trim());
      json(response, 200, { result });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
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
      id: newId("client"),
      workspaceId: url.searchParams.get("workspaceId") ?? undefined,
      roomId: url.searchParams.get("roomId") ?? undefined,
      response,
    };

    beginSse(response);
    response.write(encodeSse("ready", {}));
    this.clients.add(client);
    response.on("close", () => this.clients.delete(client));
  }

  private handleDevReload(response: ServerResponse): void {
    const client: DevClient = { response };
    beginSse(response);
    response.write(encodeSse("ready", {}));
    this.devClients.add(client);
    response.on("close", () => this.devClients.delete(client));
  }

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const root = webRoot();
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const resolved = resolve(root, requested);
    if (!pathInside(resolved, root)) {
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
    const controller = new GaiaController({
      workspaceId,
      workspace,
      setThinking: async (agentId, level) => (await this.applyThinking(workspaceId, agentId, level)).message,
      harnessHost: this.harnessBridge ? (opts) => this.harnessBridge!.hostFor(workspaceId, opts) : undefined,
    });
    controller.subscribe((event) => this.broadcast(event));
    await controller.init();
    this.controllers.set(workspaceId, controller);
    return controller;
  }

  private async selectWorkspaceRoom(workspaceId: string, roomId: string): Promise<{ snapshot: Awaited<ReturnType<GaiaController["getSnapshot"]>>; workspaceFiles: EditableFileDescriptor[]; voice: VoiceCallInfo | null }> {
    const record = await this.registry.find(workspaceId);
    if (!record) throw new Error(`Unknown workspace: ${workspaceId}`);

    const existing = this.controllers.get(workspaceId);
    if (existing?.hasActiveTask) throw new Error("Room is busy with an active task; wait for it to finish or cancel it first.");
    if (this.activeCall?.workspaceId === workspaceId && this.activeCall.info.roomId !== roomId) {
      throw new Error("Stop the active voice call before switching rooms.");
    }

    await ensureWorkspaceRoom(record.path, roomId);
    await setWorkspaceRoom(record.path, roomId);

    existing?.dispose();
    this.controllers.delete(workspaceId);
    const controller = await this.controllerFor(workspaceId);
    const snapshot = await controller.getSnapshot();
    this.broadcast({ type: "snapshot", workspaceId, roomId: controller.roomId, snapshot });
    return {
      snapshot,
      workspaceFiles: await this.files.listWorkspace(workspaceId),
      voice: this.voiceFor(workspaceId),
    };
  }

  // Settings files feed workspace/agent definitions that controllers cache at
  // creation. Rebuild affected controllers so saves apply without a restart:
  // a global file (agents, app config) touches every workspace; a workspace
  // file only its own. Busy controllers are rebuilt when their task ends.
  private async applySettingsChange(scope: "global" | "workspace", workspaceId?: string): Promise<void> {
    this.hintSourcesCache = undefined;
    const ids = scope === "global" ? [...this.controllers.keys()] : workspaceId ? [workspaceId] : [];
    await Promise.all(ids.map((id) => this.reloadController(id)));
  }

  private async reloadController(workspaceId: string): Promise<void> {
    const controller = this.controllers.get(workspaceId);
    if (!controller) return;

    if (controller.hasActiveTask) {
      if (this.pendingReloads.has(workspaceId)) return;
      this.pendingReloads.add(workspaceId);
      void controller.waitForIdle().then(() => {
        this.pendingReloads.delete(workspaceId);
        return this.reloadController(workspaceId);
      }).catch(() => {});
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

  private async handleSetThinking(request: IncomingMessage, response: ServerResponse, workspaceId: string, agentId: string): Promise<void> {
    const body = await parseBody(request);
    const level = stringField(body, "level");
    if (level === undefined) {
      json(response, 400, { error: "Missing thinking level" });
      return;
    }
    try {
      const result = await this.applyThinking(workspaceId, agentId, level);
      json(response, 200, { scope: result.scope, thinking: level || undefined });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Changes an agent's thinking level. During a voice call with that agent
  // the change is call-scoped (reverts on hang-up); otherwise the controller
  // persists it to the effective agent.json and hot-applies it. Shared by the
  // HTTP endpoint and the /thinking slash command.
  private async applyThinking(workspaceId: string, agentId: string, level: string): Promise<{ scope: "call" | "agent"; message: string }> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const controller = await this.controllerFor(workspaceId);

    const call = this.activeCall;
    if (call && call.workspaceId === workspaceId && call.info.agentId === agentId) {
      if (level === "") delete call.info.thinking;
      else call.info.thinking = level;
      this.broadcast({ type: "voice-status", workspaceId, roomId: call.info.roomId, voice: call.info });
      return { scope: "call", message: `Set @${agentId} thinking to ${level || "agent default"} for this call. It reverts on hang-up.` };
    }

    return { scope: "agent", message: await controller.setAgentThinking(agentId, level) };
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
        beginSse(response);
        this.endCompletionStream(response, completionId);
        return;
      }
      json(response, 200, completionPayload(completionId, ""));
      return;
    }

    const controller = await this.controllerFor(call.workspaceId);
    // A typed text task may be running when a voice turn arrives; give it a
    // moment to finish instead of failing the spoken turn outright.
    await controller.waitForIdle(20000);

    const task = await controller.sendMessage(turn.agentMessage, {
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
      this.endCompletionStream(response, completionId);
      return;
    }
    json(response, 200, completionPayload(completionId, reply));
  }

  private endCompletionStream(response: ServerResponse, completionId: string): void {
    response.write(completionChunk(completionId, undefined, "stop"));
    response.write(completionDone());
    response.end();
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

    // The model catalog and SDK tool set read Pi config from disk and are
    // stable for the process; cache them until a settings save invalidates.
    this.hintSourcesCache ??= { toolNames: sdkToolNames(this.options.cwd), models: readModelCatalog().models };

    const sources: HintSources = {
      agentIds,
      roomIds,
      toolNames: this.hintSourcesCache.toolNames,
      thinkingLevels: sdkThinkingLevels(),
      models: this.hintSourcesCache.models,
    };
    return buildFileHints({ label: file.label, kind: file.kind, content: file.content }, sources);
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
    const payload = encodeSse(event.type, event);
    for (const client of this.clients) {
      if (client.workspaceId && event.workspaceId && client.workspaceId !== event.workspaceId) continue;
      if (client.roomId && event.roomId && client.roomId !== event.roomId) continue;
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
        this.scheduleDevReload(name);
      });
      this.devWatchers.push(watcher);
    }
  }

  private scheduleDevReload(path: string): void {
    if (this.devReloadTimer) clearTimeout(this.devReloadTimer);
    this.devReloadTimer = setTimeout(() => {
      this.devReloadTimer = undefined;
      for (const client of this.devClients) client.response.write(encodeSse("reload", { path }));
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
