// The HTTP surface: routes → daemon calls, SSE fan-out, static files, and the
// OpenAI-compatible voice endpoints. No business logic lives here — if a
// handler grows past parsing and delegating, it belongs on the Daemon.
import { createReadStream, existsSync, openSync, readFileSync, writeSync, rmSync } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULTS, gaiaBasePath, gaiaCodesignIdentity, gaiaHost, gaiaPort } from "../../core/config.js";
import { bundledDir, expandHome, gaiaHome, globalPaths } from "../../core/paths.js";
import { sleep } from "../../core/retry.js";
import { bundleSwapNames } from "../../core/bundle-assets.js";
import { newId } from "../../core/ids.js";
import { ATTACHMENT_MAX_BYTES, attachmentMime } from "../../core/attachments.js";
import { bearerToken, cookieHeader, json, parseBody, readRawBody, text } from "../../core/http.js";
import { readJson, writeJsonAtomic } from "../../core/store.js";
import type { UiEvent } from "../../core/types.js";
import type { MemoryAction } from "../../domain/memory.js";
import { parseContextDietOverrides } from "../../domain/context-diet.js";
import { scaffoldGlobalAgent } from "../../domain/agents.js";
import { installGitGuard } from "../../domain/git-guard.js";
import { findAccount, redactedAccounts, removeAccount, updateAccount } from "../../domain/accounts.js";
import { authenticate, createUser, issueSessionToken, listUsers } from "../../domain/users.js";
import { harnessSpecs, type GaiaTool } from "../../harness/spec.js";
import { agentRoster } from "../../harness/tools.js";
import { globalAgentsPath } from "../../domain/workspace.js";
import { Daemon } from "../../daemon.js";
import { forwardLlmRequest, LLM_PROXY_MOUNT, llmProxySubpath } from "../../services/proxy.js";
import { configureRoomServiceReload } from "../../services/room-service.js";
import { summonAck } from "../../services/summons.js";
import { DEFAULT_PET_NAME, loadPet } from "../pet.js";
import type { ReadAloudDelivery } from "../../services/read-aloud.js";
import { completionChunk, completionDone, completionPayload, isStreamingRequest, modelListPayload, newCompletionId } from "../../services/voice.js";
import { AUTH_COOKIE, beginSse, boolField, encodeSse, findAppBundleRoot, matchPath, pathInside, requestingHuman, stringField } from "../route.js";
import { titleCaseId } from "./agents.js";
import { stringArrayField } from "./edit-retry.js";
import { numberField } from "./memory.js";
import { summonCensusText } from "./usage.js";
import { artifactRoutePrefix } from "./artifacts.js";
import { handleApi } from "./api.js";
import { requestReload } from "./reload.js";
export interface WebServerOptions {
  cwd: string;
  host?: string;
  port?: number;
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
// Upper bound on the graceful close inside a reload. closeServer awaits
// daemon.dispose(), and one wedged runner (an agent turn stuck retrying a dead
// upstream socket) hangs that await forever — observed live 2026-07-11 20:03:
// /rebuild stopped after keep-awake teardown, never rebuilt, never re-exec'd,
// port dead until the app was force-quit. Reload's contract is "the app always
// comes back", so past this deadline we abandon graceful teardown and proceed.
// Kept short (Pascal 2026-07-13): a wedged runner is common (mid-turn agent,
// dead upstream socket retry loop) and this is a pure wait with no durability
// payoff — pending turns persist to state.json and resume on next boot
// regardless, and the orphan sweep on boot reaps any child a skipped dispose
// left behind. 5s here was measured making /rebuild take ~7s end-to-end on a
// busy daemon vs ~2.5s idle; 1s caps that same worst case near the idle time.
const RELOAD_CLOSE_TIMEOUT_MS = 1_000;
const LISTEN_RETRY_DELAY_MS = 300;
const LISTEN_RETRIES = 10;
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
export class GaiaWebServer {
  private readonly daemon: Daemon;
  private readonly clients = new Set<SseClient>();
  private boundUrl = "";
  private server: HttpServer | undefined;
  private reloadStarted = false;
  constructor(private readonly options: WebServerOptions) {
    this.daemon = new Daemon({ cwd: options.cwd });
    this.daemon.subscribe((event) => this.broadcast(event));
    configureRoomServiceReload(() => requestReload(() => this.server ? this.closeServer(this.server) : Promise.resolve()));
  }
  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    // Daemon boot self-heal: (re)install the git-guard hook into the serving
    // workspace's shared hooks dir. Best-effort — a non-repo cwd just warns.
    installGitGuard(this.options.cwd);
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
    // Boot provenance: pid + ppid + timestamp on every start, so reload.log
    // (and any log this lands in) can attribute each daemon generation — a
    // /reload re-exec child logs a "reload requested" line from its parent
    // right above; a boot without one was spawned by something else (shell,
    // launchd, manual) and can be traced via ppid.
    console.log(`[gaia] ${new Date().toISOString()} daemon up pid=${process.pid} ppid=${process.ppid} at ${this.boundUrl}`);
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
    for (const client of this.clients) client.response.end();
    this.clients.clear();
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
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gaia.local");
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === LLM_PROXY_MOUNT || url.pathname.startsWith(`${LLM_PROXY_MOUNT}/`)) return this.handleLlmProxy(request, response, url);
      return handleApi({ request, response, url, daemon: this.daemon, human: requestingHuman(request), humanScope: requestingHuman(request)?.workspace ? requestingHuman(request)?.id : undefined, boundUrl: this.boundUrl, cwd: this.options.cwd, bootId, broadcast: (event) => this.broadcast(event), registerSse: (workspaceId, roomId) => this.registerSse(response, workspaceId, roomId) });
    }
    if (url.pathname.startsWith("/v1/")) return this.handleOpenAi(request, response, url);
    await this.serveStatic(response, url.pathname);
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
    // Mounted under a reverse-proxy prefix (GAIA_BASE_PATH, e.g. Caddy
    // `handle_path /gaia/*`)? The proxy strips the prefix before it ever
    // reaches us, so routes/assets stay unprefixed on the wire — only the two
    // HTML entry points need the prefix baked in, since the browser resolves
    // their root-relative href/src against the *public* URL, not ours. Empty
    // (root-mounted, the default) takes the exact pre-existing stream path.
    const basePath = gaiaBasePath();
    const isHtmlEntry = path.endsWith(`${sep}index.html`) || path.endsWith(`${sep}pet.html`);
    if (basePath && isHtmlEntry) {
      let html = await readFile(path, "utf8");
      html = html.replace(/(href|src)="\/(src|vendor)\//g, `$1="${basePath}/$2/`);
      html = html.replace("<head>", `<head>\n    <script>window.__GAIA_BASE_PATH__=${JSON.stringify(basePath)};</script>`);
      response.writeHead(200, headers);
      response.end(html);
      return;
    }
    response.writeHead(200, headers);
    createReadStream(path).pipe(response);
  }
  private async resolveOpenTarget(target: string, workspaceId?: string): Promise<string> {
    if (/^https?:\/\//i.test(target)) return target;
    if (/^www\./i.test(target)) return `https://${target}`;
    const withoutFilePrefix = target.startsWith("file://") ? fileURLToPath(target) : target;
    const expanded = expandHome(withoutFilePrefix);
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
  private registerSse(response: ServerResponse, workspaceId?: string, roomId?: string): void {
    const client: SseClient = { id: newId("client"), workspaceId, roomId, response };
    this.clients.add(client);
    const keepalive = setInterval(() => response.write("event: ping\ndata: {}\n\n"), 15_000);
    response.on("close", () => { clearInterval(keepalive); this.clients.delete(client); });
  }
  // --- SSE fan-out -------------------------------------------------------------------
  private broadcast(event: UiEvent): void {
    const payload = encodeSse(event.type, event);
    // `rooms` and native-pet control events are workspace-TAGGED but globally
    // DELIVERED. Room chrome keeps every sidebar live; pets must keep tracking a
    // bound agent even when that room is not selected. Every other workspace
    // event stays scoped by workspace+room (room ids are only locally unique).
    const ambient = event.type === "rooms" || event.type === "pet-bindings" || event.type === "pet-progress";
    for (const client of this.clients) {
      const scoped = event as { workspaceId?: string; roomId?: string };
      if (!ambient) {
        if (client.workspaceId && scoped.workspaceId && client.workspaceId !== scoped.workspaceId) continue;
        if (client.roomId && scoped.roomId && client.roomId !== scoped.roomId) continue;
      }
      client.response.write(payload);
    }
  }
}
export async function startWebServer(options: WebServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  return new GaiaWebServer(options).listen();
}
