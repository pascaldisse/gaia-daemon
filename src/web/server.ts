import { createReadStream, existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EditableFileRegistry } from "../app/editable-files.js";
import { GaiaController, type GaiaUiEvent } from "../app/gaia-controller.js";
import { WorkspaceRegistry, type WorkspaceRecord } from "../app/workspace-registry.js";
import { loadWorkspace, workspacePath } from "../workspace/workspace-loader.js";
import type { Workspace } from "../workspace/types.js";

interface WebServerOptions {
  cwd: string;
  host?: string;
  port?: number;
}

interface Client {
  id: string;
  workspaceId?: string;
  roomId?: string;
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

function webRoot(): string {
  return resolve(fileURLToPath(new URL("../../web", import.meta.url)));
}

export class GaiaWebServer {
  private readonly registry = new WorkspaceRegistry();
  private readonly controllers = new Map<string, GaiaController>();
  private readonly clients = new Set<Client>();
  private readonly files = new EditableFileRegistry((id) => this.workspaceForId(id));

  constructor(private readonly options: WebServerOptions) {}

  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    await this.registerCwdIfInitialized();

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
          for (const controller of this.controllers.values()) controller.dispose();
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gaia.local");
    if (url.pathname.startsWith("/api/")) {
      await this.handleApi(request, response, url);
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
      json(response, 200, { snapshot: await controller.getSnapshot(), workspaceFiles: await this.files.listWorkspace(controller.workspaceId) });
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

    if (request.method === "GET" && url.pathname === "/api/events") {
      await this.handleEvents(response, url);
      return;
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (fileMatch && request.method === "GET") {
      const fileId = decodeURIComponent(fileMatch[1] ?? "");
      json(response, 200, { file: await this.files.read(fileId, url.searchParams.get("workspaceId") ?? undefined) });
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
      this.broadcast({ type: "settings-saved", workspaceId, fileId });
      json(response, 200, { file });
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
    response.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
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

  private async registerCwdIfInitialized(): Promise<void> {
    const cwd = resolve(this.options.cwd);
    if (existsSync(workspacePath(cwd))) await this.registry.add(cwd);
  }
}

export async function startWebServer(options: WebServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  return new GaiaWebServer(options).listen();
}
