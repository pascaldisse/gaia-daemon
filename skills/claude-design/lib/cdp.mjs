// Transport: a DEDICATED headed Chromium instance + raw Chrome DevTools
// Protocol client. Never the user's interactive browser, never GAIA's own
// :9333 app-tools CDP port, never the Claude Desktop app itself — own
// executable, own --user-data-dir, own --remote-debugging-port, all
// defaulted away from those.
//
// claude.ai sits behind Cloudflare bound to a real browser TLS fingerprint;
// only a real (headed, or new-headless) Chromium clears it — raw HTTP
// clients and classic --headless both get a 403 wall.
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CDP_PORT = 9456; // distinct from gaia's own :9333 and claude-voice's :9455
export const GAIA_APP_TOOLS_PORT = 9333; // NEVER touch this port — belongs to GAIA's own app CDP surface

function detectChromium(home = homedir()) {
  const roots = ["/Applications", join(home, "Applications")];
  const bundles = [
    ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
    ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Chrome Beta", "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"],
    ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ["Vivaldi", "Vivaldi.app/Contents/MacOS/Vivaldi"],
    ["Opera", "Opera.app/Contents/MacOS/Opera"],
    ["Arc", "Arc.app/Contents/MacOS/Arc"],
  ];
  for (const root of roots)
    for (const [name, rel] of bundles) {
      const p = join(root, rel);
      if (existsSync(p)) return { name, path: p };
    }
  return null;
}

export function resolveBrowser(explicitPath, home = homedir()) {
  if (explicitPath) {
    if (existsSync(explicitPath)) return { name: explicitPath.split("/").pop(), path: explicitPath };
    throw new Error(`configured browser not found: ${explicitPath}`);
  }
  const found = detectChromium(home);
  if (!found) throw new Error("No Chromium browser found — install Brave/Chrome/Chromium/Edge/Vivaldi/Opera/Arc, or pass --browser <path>.");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpHttpGet(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/** Minimal Chrome DevTools Protocol client over a single target's websocket. */
export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
      this.ws.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: res, reject: rej } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        } else {
          this.handlers.forEach((h) => h(m.method, m.params));
        }
      });
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  on(fn) {
    this.handlers.push(fn);
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result && r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Owns one dedicated browser process + one connected page (its own profile/port). */
export class DesignBrowser {
  constructor({ cdpPort = DEFAULT_CDP_PORT, profileDir, browserPath, headless = false } = {}) {
    if (cdpPort === GAIA_APP_TOOLS_PORT) throw new Error(`refusing to use GAIA's own app-tools CDP port ${GAIA_APP_TOOLS_PORT}`);
    this.cdpPort = cdpPort;
    this.profileDir = profileDir;
    this.browserPath = browserPath;
    this.headless = headless;
    this.proc = null;
    this.page = null;
  }

  async cdpHttp(path) {
    return cdpHttpGet(this.cdpPort, path);
  }

  async isRunning() {
    try {
      await this.cdpHttp("/json/version");
      return true;
    } catch {
      return false;
    }
  }

  async launch() {
    if (await this.isRunning()) return; // already up on this port/profile — reuse it
    const browser = resolveBrowser(this.browserPath);
    mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1280,900",
    ];
    if (this.headless) args.push("--headless=new", "--disable-gpu");
    args.push("about:blank");
    this.proc = spawn(browser.path, args, { detached: true, stdio: "ignore" });
    this.proc.unref();
    this.browserName = browser.name;
    let ok = false;
    for (let i = 0; i < 60; i++) {
      if (await this.isRunning()) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error(`${browser.name} CDP never came up on :${this.cdpPort}`);
  }

  async connect() {
    let target;
    let pages = [];
    for (let i = 0; i < 40; i++) {
      const list = await this.cdpHttp("/json");
      pages = list.filter((t) => t.type === "page");
      target = pages.find((t) => (t.url || "").startsWith("https://claude.ai")) || pages[0];
      if (target) break;
      await sleep(300);
    }
    if (!target) throw new Error("no page target found on dedicated browser");
    this.page = new CDP(target.webSocketDebuggerUrl);
    await this.page.open();
    await this.page.send("Network.enable");
    await this.page.send("Page.enable");
    await this.page.send("Runtime.enable");
    this.page._targetId = target.id;
    return target;
  }

  async navigate(url) {
    await this.page.send("Page.navigate", { url });
  }

  async setCookie(name, value, domain = ".claude.ai") {
    return this.page.send("Network.setCookie", {
      name,
      value,
      domain,
      path: "/",
      secure: true,
      httpOnly: name === "sessionKey",
      sameSite: "Lax",
    });
  }

  async screenshotBase64(format = "png") {
    const r = await this.page.send("Page.captureScreenshot", { format });
    return r.data;
  }

  async title() {
    return this.page.eval("document.title");
  }

  async url() {
    return this.page.eval("location.href");
  }

  close() {
    if (this.page) this.page.close();
  }
}
