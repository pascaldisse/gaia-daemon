// The HTTP surface: routes → daemon calls, SSE fan-out, static files, and the
// OpenAI-compatible voice endpoints. No business logic lives here — if a
// handler grows past parsing and delegating, it belongs on the Daemon.

import { createReadStream, existsSync, openSync, watch, type FSWatcher } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULTS, gaiaHost, gaiaPort } from "../core/config.js";
import { bundledDir, gaiaHome, globalPaths } from "../core/paths.js";
import { newId } from "../core/ids.js";
import { ATTACHMENT_MAX_BYTES, attachmentMime } from "../core/attachments.js";
import { bearerToken, json, parseBody, readRawBody, text } from "../core/http.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import type { UiEvent } from "../core/types.js";
import type { MemoryAction } from "../domain/memory.js";
import { scaffoldGlobalAgent } from "../domain/agents.js";
import { findAccount, redactedAccounts, removeAccount } from "../domain/accounts.js";
import { harnessSpecs } from "../harness/spec.js";
import { globalAgentsPath } from "../domain/workspace.js";
import { Daemon } from "../daemon.js";
import { forwardLlmRequest, LLM_PROXY_MOUNT, llmProxySubpath } from "../services/proxy.js";
import { configureRoomServiceReload } from "../services/room-service.js";
import { summonAck } from "../services/summons.js";
import type { ReadAloudDelivery } from "../services/read-aloud.js";
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

// A dictation clip is short spoken audio, not a media upload — a few MiB of
// opus is minutes of speech. Cap well below the attachment limit.
const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;
const bootId = randomUUID();
const RELOAD_DELAY_MS = 250;
const LISTEN_RETRY_DELAY_MS = 300;
const LISTEN_RETRIES = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Total death (cmd+Q / SIGTERM) needs an authoritative pid: the shell reads
 * this file rather than trusting the pid of whatever it originally spawned,
 * because /reload re-execs the daemon into a NEW process that rewrites this
 * same file on its own boot (see writePidfile/removePidfile below). */
function pidfilePath(): string {
  return join(gaiaHome(), "daemon.pid");
}

/** A daemon spawned by the Tauri shell with GAIA_PARENT_PID must never outlive
 * that shell: poll every 2s and exit as soon as the parent is gone (a signal-0
 * kill throws once the pid no longer exists). No-op when the env var is
 * absent or not a positive integer — e.g. a daemon started standalone. */
function installParentWatchdog(): void {
  const parentPid = Number.parseInt(process.env.GAIA_PARENT_PID ?? "", 10);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.error(`[daemon] parent GAIA shell (pid ${parentPid}) is gone — exiting`);
      process.exit(0);
    }
  }, 2000).unref();
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function boolField(body: unknown, field: string): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as Record<string, unknown>)[field] === true;
}

/** An array-of-strings field, present (even empty) vs. absent distinguished —
 * callers use `undefined` as "field wasn't sent" and `[]` as "sent empty". */
function stringArrayField(body: unknown, field: string): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>)[field];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((item): item is string => typeof item === "string");
}

/** Attachment references on a message body: `[{ id, name?, mime? }]`. Only the
 * server-issued id matters for path resolution; name/mime are display echoes. */
function attachmentRefs(body: unknown): { id: string; name?: string; mime?: string }[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return undefined;
  const refs: { id: string; name?: string; mime?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) continue;
    refs.push({
      id: record.id,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
    });
  }
  return refs.length > 0 ? refs : undefined;
}

/** Sanitize-apply edits: `[{ eventId, quote, replacement }]`. The service
 * re-validates every quote against the live transcript before rewriting. */
function sanitizeEditRefs(body: unknown): { eventId: string; quote: string; replacement: string }[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as Record<string, unknown>).edits;
  if (!Array.isArray(raw)) return [];
  const edits: { eventId: string; quote: string; replacement: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.eventId !== "string" || !record.eventId.trim()) continue;
    if (typeof record.quote !== "string" || record.quote.length === 0) continue;
    if (typeof record.replacement !== "string") continue;
    edits.push({ eventId: record.eventId, quote: record.quote, replacement: record.replacement });
  }
  return edits;
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
  private server: HttpServer | undefined;
  private reloadStarted = false;

  constructor(private readonly options: WebServerOptions) {
    this.daemon = new Daemon({ cwd: options.cwd });
    this.daemon.subscribe((event) => this.broadcast(event));
    configureRoomServiceReload(() => this.requestReload());
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
    this.server = server;

    const host = this.options.host ?? gaiaHost();
    const port = this.options.port ?? gaiaPort();
    await this.listenWithRetry(server, port, host);
    await this.writePidfile();
    installParentWatchdog();

    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    this.boundUrl = `http://${host}:${boundPort}`;
    await this.daemon.boot(this.boundUrl);

    return {
      url: `${this.boundUrl}/`,
      close: () => this.closeServer(server),
    };
  }

  private async listenWithRetry(server: HttpServer, port: number, host: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolveListen, reject) => {
          const onError = (error: NodeJS.ErrnoException): void => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off("error", onError);
            resolveListen();
          };
          server.once("error", onError);
          server.listen(port, host, onListening);
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < LISTEN_RETRIES) {
          await sleep(LISTEN_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }
  }

  private async closeServer(server: HttpServer): Promise<void> {
    // Idempotency guard: SIGTERM/SIGINT can race a second close (e.g. the
    // process-level handler in cli.ts firing alongside another shutdown path)
    // — a repeat call must no-op rather than double-dispose or double-close
    // an already-closed net.Server.
    if (this.server !== server) return;
    this.server = undefined;
    await this.daemon.dispose();
    for (const watcher of this.devWatchers) watcher.close();
    this.devWatchers.length = 0;
    if (this.devReloadTimer) clearTimeout(this.devReloadTimer);
    for (const client of this.clients) client.response.end();
    this.clients.clear();
    for (const client of this.devClients) client.end();
    this.devClients.clear();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
      server.closeAllConnections?.();
    });
    await this.removePidfile();
  }

  /** Write <gaia home>/daemon.pid after a successful bind — the authority the
   * Tauri shell (and `kill -TERM`) uses to find and terminate the daemon.
   * Best-effort: a pidfile write failure must not stop the daemon serving. */
  private async writePidfile(): Promise<void> {
    try {
      await mkdir(gaiaHome(), { recursive: true });
      await writeFile(pidfilePath(), `${process.pid}\n`, "utf8");
    } catch (error) {
      console.error(`gaia: failed to write pidfile: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Delete the pidfile on graceful shutdown. The /reload re-exec child
   * rewrites it on its own boot (writePidfile runs on every listen()), so
   * deleting here — before the new process comes up — is correct: there is
   * a brief window with no pidfile, never a stale one pointing at a dead pid. */
  private async removePidfile(): Promise<void> {
    try {
      await unlink(pidfilePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`gaia: failed to remove pidfile: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private requestReload(): void {
    if (this.reloadStarted) return;
    this.reloadStarted = true;
    setTimeout(() => {
      void this.reloadNow();
    }, RELOAD_DELAY_MS);
  }

  private async reloadNow(): Promise<void> {
    try {
      if (this.server) await this.closeServer(this.server);
      // Re-exec with the SAME node loader flags: tsx's --require/--import live
      // in process.execArgv, NOT process.argv — without them the child is plain
      // `node src/cli.ts`, which dies instantly and leaves the port dead (the
      // exact "/reload froze the app" failure). And never stdio:"ignore" here:
      // a crashing reload child must leave a corpse we can read.
      const reloadLog = openSync(join(gaiaHome(), "reload.log"), "a");
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        detached: true,
        stdio: ["ignore", reloadLog, reloadLog],
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();
      process.exit(0);
    } catch (error) {
      console.error(`gaia: reload failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gaia.local");
    if (this.options.dev && request.method === "GET" && url.pathname === "/__dev/reload") {
      beginSse(response);
      response.write(encodeSse("ready", { bootId }));
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

    // "Keep laptop awake" (Global Settings ▸ General): persist + apply
    // immediately. `enabled` off-macOS still persists the preference (inert
    // there — services/keep-awake.ts) so it takes effect if this daemon later
    // runs on a Mac.
    if (method === "POST" && path === "/api/app/keep-awake") {
      const body = await parseBody(request);
      const enabled = boolField(body, "enabled");
      return this.respond(response, async () => ({ keepAwake: await this.daemon.setKeepAwake(enabled) }));
    }

    // "Your name" (Global Settings ▸ General): the label the shared transcript
    // renderer uses for the human's own messages, in place of the anonymous
    // "user" token (services/user-name.ts). "" clears it back to that default.
    if (method === "POST" && path === "/api/app/user-name") {
      const body = await parseBody(request);
      const name = stringField(body, "name") ?? "";
      return this.respond(response, async () => ({ userName: await this.daemon.setUserName(name) }));
    }

    if (
      method === "POST" &&
      (path === "/api/harness/memory" || path === "/api/harness/summon" || path === "/api/harness/recall" || path === "/api/harness/dream")
    ) {
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

    // Manual usage refresh (the popover's ↻ button) — probes every declared
    // account NOW, bypassing throttle and backoff, and answers with the fresh
    // snapshot directly so the button works even when SSE hiccups.
    if (method === "POST" && path === "/api/usage/refresh") {
      await this.daemon.refreshUsage();
      json(response, 200, { accounts: this.daemon.usageSnapshot() });
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
      response.write(encodeSse("ready", { bootId }));
      // Seed the account-usage chip: the SSE fan-out only carries events emitted
      // while this client is subscribed, so replay the cached usage now instead
      // of leaving the chip blank until the next daemon poll.
      for (const event of this.daemon.currentUsage()) response.write(encodeSse(event.type, event));
      this.clients.add(client);
      response.on("close", () => this.clients.delete(client));
      return;
    }

    // Chat-wide transcript search (web client). ?q= the query; optional
    // ?workspace= narrows to one workspace, ?room= to one chat (in-chat search),
    // ?limit= caps results. Cross-workspace by default.
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      const workspaceId = url.searchParams.get("workspace")?.trim();
      const roomId = url.searchParams.get("room")?.trim();
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return this.respond(response, () =>
        this.daemon.searchChats(q, {
          ...(workspaceId ? { workspaceId } : {}),
          ...(roomId ? { roomId } : {}),
          ...(limit ? { limit } : {}),
        }),
      );
    }

    // Parameterized workspace routes.
    const match = (pattern: RegExp): string[] | null => {
      const result = path.match(pattern);
      return result ? result.slice(1).map((part) => decodeURIComponent(part ?? "")) : null;
    };

    let params: string[] | null;

    // Named accounts. The login routes are registered BEFORE DELETE
    // /api/accounts/<id> so "login" is never mistaken for an account id.
    if (method === "GET" && path === "/api/accounts") {
      return this.respond(response, async () => ({
        accounts: redactedAccounts(),
        harnesses: harnessSpecs()
          .filter((s) => s.accounts)
          .map((s) => ({ id: s.id, label: s.accounts?.label, login: Boolean(s.accounts?.login) })),
      }));
    }

    if (method === "POST" && path === "/api/accounts/login") {
      const body = await parseBody(request);
      const harness = stringField(body, "harness");
      const label = stringField(body, "label");
      return this.respond(response, async () => ({
        session: this.daemon.accountLogins.start((harness ?? "").trim(), label?.trim() || undefined),
      }));
    }

    if (method === "GET" && (params = match(/^\/api\/accounts\/login\/([^/]+)$/))) {
      return this.respond(response, async () => ({ session: this.daemon.accountLogins.status(params![0]) }));
    }

    if (method === "POST" && (params = match(/^\/api\/accounts\/login\/([^/]+)\/input$/))) {
      const body = await parseBody(request);
      const textValue = stringField(body, "text") ?? "";
      return this.respond(response, async () => {
        this.daemon.accountLogins.input(params![0], textValue);
        return { session: this.daemon.accountLogins.status(params![0]) };
      });
    }

    if (method === "DELETE" && (params = match(/^\/api\/accounts\/login\/([^/]+)$/))) {
      return this.respond(response, async () => {
        this.daemon.accountLogins.cancel(params![0]);
        return { session: this.daemon.accountLogins.status(params![0]) };
      });
    }

    if (method === "DELETE" && (params = match(/^\/api\/accounts\/([^/]+)$/))) {
      return this.respond(response, async () => ({ removed: removeAccount(params![0]) }));
    }

    // Per-agent account binding: which named account (if any) an agent's
    // harness subprocess runs under. Harness-blind — compares harness id
    // STRINGS pulled from agent.json/accounts.json data, never a literal id.
    if (method === "POST" && (params = match(/^\/api\/agents\/([^/]+)\/account$/))) {
      const agentId = params[0];
      const configPath = join(globalAgentsPath(), agentId, "agent.json");
      if (!existsSync(configPath)) return json(response, 404, { error: `unknown agent '${agentId}'` });
      const body = await parseBody(request);
      const rawAccount = (body as { account?: unknown } | undefined)?.account;
      const account = typeof rawAccount === "string" && rawAccount.trim() ? rawAccount.trim() : null;
      try {
        const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;
        if (account) {
          const record = findAccount(account);
          if (!record) return json(response, 400, { error: `unknown account '${account}'` });
          const agentHarness = typeof config.harness === "string" && config.harness.trim() ? config.harness : DEFAULTS.harness;
          if (record.harness !== agentHarness) {
            return json(response, 400, { error: `account '${account}' is for harness '${record.harness}', agent uses '${agentHarness}'` });
          }
          config.account = account;
        } else {
          delete config.account;
        }
        await writeJsonAtomic(configPath, config);
        await this.daemon.applySettingsChange("global");
        json(response, 200, { agent: { id: agentId, account } });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "GET" && (params = match(/^\/api\/workspaces\/([^/]+)\/snapshot$/))) {
      const service = await this.daemon.serviceFor(params[0]);
      json(response, 200, {
        snapshot: await service.getSnapshot(),
        workspaceFiles: await this.daemon.files.listWorkspace(service.workspaceId),
        voice: this.daemon.voiceFor(service.workspaceId),
      });
      return;
    }

    if (method === "GET" && (params = match(/^\/api\/workspaces\/([^/]+)\/memory\/status$/))) {
      return this.respond(response, async () => ({ health: await this.daemon.memoryHealth(params![0]) }));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms$/))) {
      const body = await parseBody(request);
      const roomId = stringField(body, "roomId") ?? stringField(body, "id") ?? stringField(body, "room");
      if (!roomId?.trim()) return json(response, 400, { error: "Missing room id" });
      const incognito = boolField(body, "incognito");
      return this.respond(response, () => this.daemon.selectRoom(params![0], roomId.trim(), { incognito }));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(?:select|activate)$/))) {
      // The body is optional; when a room is being CREATED via select, it may
      // carry `incognito: true` (a no-op on an already-existing room).
      const incognito = boolField(await parseBody(request), "incognito");
      return this.respond(response, () => this.daemon.selectRoom(params![0], params![1], { incognito }));
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

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/default-role$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId");
      const role = stringField(body, "role");
      if (!agentId?.trim()) return json(response, 400, { error: "Missing agentId" });
      return this.respond(response, () => this.daemon.setAgentDefaultRole(params![0], agentId.trim(), (role ?? "").trim()));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/agent-dialogue$/))) {
      const body = await parseBody(request);
      const on = (body as { on?: unknown }).on === true;
      return this.respond(response, () => this.daemon.setRoomAgentDialogue(params![0], params![1], on));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/title$/))) {
      const body = await parseBody(request);
      const title = stringField(body, "title")?.trim();
      if (!title) return json(response, 400, { error: "Missing room title" });
      return this.respond(response, () => this.daemon.renameRoom(params![0], params![1], title));
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/favorite$/))) {
      const favorite = (await parseBody(request) as { favorite?: unknown }).favorite === true;
      return this.respond(response, () => this.daemon.setRoomFavorite(params![0], params![1], favorite));
    }

    // Attachment upload: the pasted file's bytes as the raw body, original
    // filename in ?name=. Returns the server-issued id the client echoes back
    // on the message send. Serving is GET on the same path + /<id>.
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/files$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const name = url.searchParams.get("name")?.trim() || "pasted-file";
      const contentType = request.headers["content-type"];
      const mime = typeof contentType === "string" && contentType !== "application/octet-stream" ? contentType.split(";")[0].trim() : undefined;
      try {
        const data = await readRawBody(request, ATTACHMENT_MAX_BYTES);
        if (data.length === 0) return json(response, 400, { error: "Empty file" });
        const stored = await service.storeAttachment(name, data, mime);
        json(response, 201, { attachment: { id: stored.id, name: stored.name, mime: stored.mime, size: stored.size } });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "GET" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/files\/([^/]+)$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const filePath = service.attachmentPath(params[2]);
      if (!existsSync(filePath) || !(await stat(filePath)).isFile()) return json(response, 404, { error: "Not found" });
      // Ids are unique per upload, so the bytes are immutable — cache hard.
      response.writeHead(200, { "content-type": attachmentMime(params[2]), "cache-control": "max-age=31536000, immutable" });
      createReadStream(filePath).pipe(response);
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/messages$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const body = await parseBody(request);
      const textValue = stringField(body, "text") ?? "";
      const refs = attachmentRefs(body);
      // A picture with no words is a valid message; no words and no files is not.
      if (!textValue.trim() && !refs) return json(response, 400, { error: "Missing message text" });
      let attachments;
      if (refs) {
        try {
          attachments = await service.resolveAttachments(refs);
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // queue:true is the Cmd/Ctrl+Enter opt-out of steer-by-default — force the
      // durable queue instead of injecting into the running turn.
      const queue = (body as { queue?: unknown }).queue === true;
      const task = await service.sendMessage(textValue, { ...(attachments ? { attachments } : {}), ...(queue ? { queue } : {}) });
      json(response, 202, { task });
      return;
    }

    // Fork-from-message: retry regenerates the reply produced by a user
    // message; edit re-sends it with new text. Both truncate the transcript
    // at that message (dropped events preserved in rewound.jsonl).
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/(retry|edit)$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const body = await parseBody(request);
      const eventId = stringField(body, "eventId");
      const text = stringField(body, "text");
      // Which of the original message's own attachments (by path) survive the
      // edit. Absent => keep all (unchanged behavior); present (even []) =>
      // narrow to that set. Never lets the client attach a NEW path — see
      // editMessage's doc comment.
      const keepAttachmentPaths = stringArrayField(body, "keepAttachments");
      if (!eventId?.trim()) return json(response, 400, { error: "Missing eventId" });
      if (params[2] === "edit" && !text?.trim()) return json(response, 400, { error: "Missing message text" });
      try {
        const task =
          params[2] === "edit"
            ? await service.editMessage(eventId.trim(), text!, keepAttachmentPaths)
            : await service.retryMessage(eventId.trim());
        json(response, 202, { task });
      } catch (error) {
        json(response, 409, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // Backwards paging through committed history ("load older" in the
    // transcript): the events immediately before ?before=<eventId>.
    if (method === "GET" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/events$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const before = url.searchParams.get("before")?.trim() || undefined;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      return this.respond(response, async () => service.eventsBefore(before, limit));
    }

    // Thanks-Dario context sanitize. POST runs the reviewer persona and
    // returns his proposal (slow — a real agent turn); GET returns the last
    // saved proposal; POST /apply rewrites the approved events (originals
    // preserved in redactions.jsonl) and resets sessions.
    if ((params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/sanitize$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      if (method === "GET") return this.respond(response, async () => ({ proposal: await service.getSanitizeProposal() }));
      if (method === "POST") return this.respond(response, async () => ({ proposal: await service.sanitizePreview() }));
    }
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/sanitize\/apply$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const body = await parseBody(request);
      const edits = sanitizeEditRefs(body);
      if (edits.length === 0) return json(response, 400, { error: "No edits provided" });
      try {
        json(response, 200, await service.sanitizeApply(edits));
      } catch (error) {
        json(response, 409, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/summons$/))) {
      const body = await parseBody(request);
      const agentId = stringField(body, "agentId") ?? stringField(body, "agent");
      const taskText = stringField(body, "task");
      if (!agentId || !taskText?.trim()) return json(response, 400, { error: "Missing agentId or task" });
      try {
        const coordinator = await this.daemon.coordinatorFor(params[0]);
        // UI-initiated: the human reads the result as a note in the parent room.
        const childRoomId = await coordinator.summon(params[1], agentId, taskText.trim(), { deliver: "note" });
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

    // Drop ONE durably-queued message (the ✕ on a queued ghost bubble). Queue
    // ops live entirely in the shared room layer, so this is harness-agnostic —
    // no runtime is touched. 404 when it already started running (can't unqueue
    // a turn in flight).
    if (method === "DELETE" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/queue\/([^/]+)$/))) {
      const service = await this.daemon.serviceFor(params[0], params[1]);
      const task = await service.deleteQueuedMessage(params[2]);
      if (!task) return json(response, 404, { error: "Queued message not found (it may have already started running)" });
      json(response, 200, { task });
      return;
    }

    // Reversible room delete: moves the room dir to trash and purges it from
    // memory. Returns the neighbour room's snapshot (a room is always in view).
    if (method === "DELETE" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)$/))) {
      return this.respond(response, () => this.daemon.deleteRoom(params![0], params![1]));
    }

    // De-register a workspace: drops it from GAIA's recent-workspaces list and
    // tears down its resident services. Files on disk are never touched. Returns
    // the fresh app payload (a remaining workspace selected, or none).
    if (method === "DELETE" && (params = match(/^\/api\/workspaces\/([^/]+)$/))) {
      return this.respond(response, () => this.daemon.deleteWorkspace(params![0]));
    }

    // Read-aloud: one committed agent message → speech audio (the transcript
    // play button), one chunk per request. The daemon resolves the author's
    // Context gate: resolve a held new-agent first turn with the chosen amount
    // of context — "full", "last" (+ n messages), or "compact".
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/context-gate$/))) {
      const body = await parseBody(request);
      const choice = stringField(body, "choice");
      if (choice !== "full" && choice !== "last" && choice !== "compact") {
        return json(response, 400, { error: "choice must be full | last | compact" });
      }
      const nRaw = body && typeof body === "object" ? (body as Record<string, unknown>).n : undefined;
      const n = typeof nRaw === "number" && Number.isInteger(nRaw) && nRaw > 0 ? nRaw : undefined;
      try {
        await this.daemon.resolveContextGate(params[0], params[1], choice, n);
        return json(response, 200, { ok: true });
      } catch (error) {
        return json(response, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // engine+voice; this layer only streams the bytes. The x-tts-chunks
    // header tells the client how many chunks to fetch/play in sequence.
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/read-aloud$/))) {
      const body = await parseBody(request);
      const eventId = stringField(body, "eventId");
      if (!eventId?.trim()) return json(response, 400, { error: "Missing eventId" });
      const chunkRaw = body && typeof body === "object" ? (body as Record<string, unknown>).chunk : undefined;
      const chunk = typeof chunkRaw === "number" && Number.isInteger(chunkRaw) && chunkRaw >= 0 ? chunkRaw : 0;
      const regenerate = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).regenerate === true);
      try {
        const audio = await this.daemon.readAloud(params[0], params[1], eventId.trim(), chunk, regenerate);
        response.writeHead(200, {
          "content-type": audio.contentType,
          "content-length": audio.audio.length,
          "cache-control": "no-store",
          "x-tts-chunks": String(audio.chunks),
          "x-tts-chunk": String(audio.chunk),
        });
        response.end(audio.audio);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(
          response,
          message.startsWith("Unknown event") ? 404 : message.startsWith("Only agent") || message.startsWith("Nothing to read") || message.startsWith("Unknown chunk") ? 400 : 502,
          { error: message },
        );
      }
      return;
    }

    // Read-aloud, streamed: the whole message as one continuous PCM pass, played
    // frame-by-frame as it is generated (the claude.ai desktop-app path). The
    // author's engine decides the mode — a batch-only engine answers "chunks",
    // and the client keeps the per-chunk /read-aloud path above.
    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/rooms\/([^/]+)\/read-aloud\/stream$/))) {
      const body = await parseBody(request);
      const eventId = stringField(body, "eventId");
      if (!eventId?.trim()) return json(response, 400, { error: "Missing eventId" });
      const regenerate = Boolean(body && typeof body === "object" && (body as Record<string, unknown>).regenerate === true);
      let delivery: ReadAloudDelivery;
      try {
        delivery = await this.daemon.readAloudStream(params[0], params[1], eventId.trim(), regenerate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          response,
          message.startsWith("Unknown event") ? 404 : message.startsWith("Only agent") || message.startsWith("Nothing to read") ? 400 : 502,
          { error: message },
        );
      }
      if (delivery.mode === "chunks") return json(response, 200, { mode: "chunks", chunks: delivery.chunks });

      response.writeHead(200, {
        "content-type": "audio/pcm",
        "cache-control": "no-store",
        "x-tts-mode": "stream",
        "x-tts-rate": String(delivery.format.sampleRate),
        "x-tts-channels": String(delivery.format.channels),
        "x-tts-bits": String(delivery.format.bitsPerSample),
      });
      let clientGone = false;
      response.on("close", () => { clientGone = true; });
      try {
        for await (const frame of delivery.frames) {
          if (clientGone || response.writableEnded) break;
          if (!response.write(frame)) {
            await new Promise<void>((resolve) => {
              const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); };
              response.once("drain", done);
              response.once("close", done);
            });
          }
        }
      } catch {
        // Mid-stream failure: headers are already sent, so just close.
      }
      if (!response.writableEnded) response.end();
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
        const result = await this.daemon.transcribe({ data, contentType: mime }, { engineId, language });
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
        const result = await this.daemon.transcribe({ data, contentType: mime }, { engineId, language });
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

    if (method === "POST" && (params = match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/))) {
      const body = await parseBody(request);
      const level = stringField(body, "level");
      const roomId = stringField(body, "roomId");
      if (level === undefined) return json(response, 400, { error: "Missing thinking level" });
      try {
        const result = await this.daemon.applyThinking(params[0], roomId, params[1], level);
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
  // `dream` is the one exception: it is never a grantable GaiaTool (no entry,
  // no Claude/Pi grant — see cli-tools.ts's runDream comment), so it skips the
  // gate below and only needs the same bearer-token authentication.
  private async handleHarness(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const claims = this.daemon.verifyHarnessToken(bearerToken(request));
    if (!claims) return json(response, 401, { error: "Invalid or missing harness token." });

    let workspace;
    try {
      workspace = (await this.daemon.serviceFor(claims.workspaceId, claims.roomId)).workspace;
    } catch (error) {
      return json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }

    const verb = pathname.slice("/api/harness/".length).split("/")[0] as "memory" | "summon" | "recall" | "dream";
    if (verb !== "dream" && !this.daemon.harnessGaiaTools(workspace, claims.agentId).includes(verb)) {
      return json(response, 403, { error: `This agent's harness does not grant the ${verb} tool.` });
    }

    const body = await parseBody(request);

    if (pathname === "/api/harness/memory") {
      // Batch mode (§5): operations validate together against the FINAL
      // budget and commit atomically — one write, all-or-nothing.
      const rawOps = (body as Record<string, unknown>).operations;
      if (Array.isArray(rawOps)) {
        const operations = rawOps
          .filter((op): op is Record<string, unknown> => !!op && typeof op === "object")
          .filter((op) => op.action === "add" || op.action === "replace" || op.action === "remove")
          .map((op) => ({
            action: op.action as MemoryAction,
            ...(typeof op.content === "string" ? { content: op.content } : {}),
            ...(typeof op.old_text === "string" ? { oldText: op.old_text } : typeof op.oldText === "string" ? { oldText: op.oldText } : {}),
          }));
        if (!operations.length) return json(response, 400, { error: "operations must be a non-empty array of {action, content?, old_text?}" });
        try {
          const result = await this.daemon.harnessMemoryBatch(claims, stringField(body, "file") ?? "MEMORY.md", operations);
          const head = `${result.ok ? "OK" : "ERROR"}: ${result.message}`;
          json(response, 200, { result: result.ok ? `${head}\n\n${result.state.content}` : head, ok: result.ok, message: result.message });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
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

    if (pathname === "/api/harness/recall") {
      const numberField = (name: string): number | undefined => {
        const raw = (body as Record<string, unknown>)[name];
        return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : undefined;
      };
      // Scroll mode (§8): a raw transcript window around a prior hit id.
      const around = numberField("around");
      if (around !== undefined) {
        const span = numberField("span");
        const offset = numberField("offset");
        try {
          const result = await this.daemon.harnessRecallScroll(claims, around, {
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
        const { result, hits } = await this.daemon.harnessRecall(claims, query, numberField("limit"), { summarize });
        json(response, 200, { ok: true, result, hits });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

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
        const result = apply ? await this.daemon.harnessDreamApply(claims, agentId) : await this.daemon.harnessDreamPropose(claims, agentId);
        json(response, 200, { ok: true, result });
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
      const coordinator = await this.daemon.coordinatorFor(claims.workspaceId);
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
    const root = bundledDir("web");
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const resolved = resolve(root, requested);
    if (!pathInside(resolved, root)) return text(response, 403, "Forbidden");

    const path = existsSync(resolved) && (await stat(resolved)).isFile() ? resolved : join(root, "index.html");
    const headers: Record<string, string> = { "content-type": MIME[extname(path)] ?? "application/octet-stream" };
    // Web assets are raw, unhashed, and edited live (no build step / no content
    // hashing), so they must never be heuristically cached: a stale ES module
    // silently ships old UI code on reload — notably in the native app's
    // WKWebView, which caches aggressively. Always require a fresh fetch.
    headers["cache-control"] = "no-store";

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
    // `rooms` is workspace-TAGGED but globally DELIVERED: it carries a
    // workspaceId only so the client knows which workspace it describes, and
    // must reach EVERY client (not just those viewing that workspace) so the
    // sidebar's workspace-level running/unread dots stay live for workspaces
    // you're not currently in. Every other workspace-scoped event targets a
    // specific room — room ids are unique only WITHIN a workspace, so those stay
    // scoped by both ids.
    const ambient = event.type === "rooms";
    for (const client of this.clients) {
      const scoped = event as { workspaceId?: string; roomId?: string };
      if (!ambient) {
        if (client.workspaceId && scoped.workspaceId && client.workspaceId !== scoped.workspaceId) continue;
        if (client.roomId && scoped.roomId && client.roomId !== scoped.roomId) continue;
      }
      client.response.write(payload);
    }
  }

  private async startDevWatchers(): Promise<void> {
    const root = bundledDir("web");
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
