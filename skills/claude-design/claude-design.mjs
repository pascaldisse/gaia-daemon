#!/usr/bin/env bun
// claude-design — dedicated Claude Design (claude.ai/design) canvas control.
//
// Zero-dependency Bun CLI: own headed Chromium instance, own profile, own CDP
// port (default 9456). Bootstraps auth by decrypting the LOCAL Claude Desktop
// app's own already-logged-in session (Cookies DB + macOS Keychain "Claude
// Safe Storage" item) and injecting it into the dedicated browser — never
// touches the desktop app, GAIA's own :9333 app-tools CDP, or the user's
// interactive browser/profile. Never logs secret values.
//
// Commands: doctor, start/open, status, inspect, screenshot, prompt/create,
// sync (optional official Claude Code /design-sync passthrough).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs, usage } from "./lib/argv.mjs";
import { DesignBrowser, DEFAULT_CDP_PORT, GAIA_APP_TOOLS_PORT } from "./lib/cdp.mjs";
import { getDesktopSession, desktopCookiesDbPath, WANTED_COOKIES } from "./lib/session.mjs";
import { SEMANTIC, existsExpr, resolve as resolveSemantic, inspectAll } from "./lib/selectors.mjs";
import { DEFAULT_PROFILE_DIR, loadOptions } from "./lib/state.mjs";

const DESIGN_URL = "https://claude.ai/design";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBrowser(opts) {
  const env = loadOptions();
  const cdpPort = opts.cdpPort ?? env.cdpPort ?? DEFAULT_CDP_PORT;
  const profileDir = resolvePath(opts.profileDir ?? env.profileDir ?? DEFAULT_PROFILE_DIR);
  const browserPath = opts.browser ?? env.browserPath;
  const headless = opts.headless || env.headless;
  return new DesignBrowser({ cdpPort, profileDir, browserPath, headless });
}

async function ensureAuthenticated(browser, { autoLogin = true } = {}) {
  const loggedIn = await resolveSemantic((e) => browser.page.eval(e, false), SEMANTIC.LOGGED_IN_MARKER);
  if (loggedIn.matched) return true;
  if (!autoLogin) return false;
  const session = getDesktopSession();
  if (!session) return false;
  for (const name of WANTED_COOKIES) {
    const val = session[name];
    if (!val) continue;
    await browser.setCookie(name, val);
  }
  await browser.navigate("https://claude.ai/new");
  await sleep(6000);
  const after = await resolveSemantic((e) => browser.page.eval(e, false), SEMANTIC.LOGGED_IN_MARKER);
  return after.matched;
}

async function openDesign(browser) {
  await browser.launch();
  await browser.connect();
  await sleep(1500);
  await ensureAuthenticated(browser);
  await browser.navigate(DESIGN_URL);
  await sleep(4000);
}

async function cmdDoctor() {
  const lines = [];
  let ok = true;

  const cookiesDb = desktopCookiesDbPath();
  lines.push(cookiesDb ? `[ok] desktop Cookies DB found: ${cookiesDb}` : "[fail] desktop Cookies DB not found (Claude Desktop app never run?)");
  if (!cookiesDb) ok = false;

  const keychain = spawnSync("security", ["find-generic-password", "-ws", "Claude Safe Storage"], { encoding: "utf8" });
  const hasKeychainItem = keychain.status === 0;
  lines.push(hasKeychainItem ? "[ok] Keychain item 'Claude Safe Storage' readable" : "[fail] Keychain item 'Claude Safe Storage' not accessible");
  if (!hasKeychainItem) ok = false;

  const session = hasKeychainItem && cookiesDb ? getDesktopSession() : null;
  lines.push(session ? "[ok] decrypted a sessionKey from the desktop app cookie jar" : "[fail] could not decrypt a desktop sessionKey");
  if (!session) ok = false;

  try {
    const { resolveBrowser } = await import("./lib/cdp.mjs");
    const browserInfo = resolveBrowser();
    lines.push(`[ok] Chromium-family browser found: ${browserInfo.name} (${browserInfo.path})`);
  } catch (e) {
    lines.push(`[fail] ${e.message}`);
    ok = false;
  }

  const port = makeBrowser({}).cdpPort;
  lines.push(port === GAIA_APP_TOOLS_PORT ? `[fail] configured CDP port collides with GAIA app-tools (${GAIA_APP_TOOLS_PORT})` : `[ok] dedicated CDP port ${port} (never ${GAIA_APP_TOOLS_PORT})`);
  if (port === GAIA_APP_TOOLS_PORT) ok = false;

  console.log(lines.join("\n"));
  return ok ? 0 : 1;
}

async function cmdStart(opts) {
  const browser = makeBrowser(opts);
  await openDesign(browser);
  console.log(`opened ${DESIGN_URL} on dedicated CDP :${browser.cdpPort} (profile: ${browser.profileDir})`);
  return 0;
}

async function cmdStatus(opts) {
  const browser = makeBrowser(opts);
  if (!(await browser.isRunning())) {
    console.log(JSON.stringify({ running: false, cdpPort: browser.cdpPort }, null, 2));
    return 1;
  }
  await browser.connect();
  const title = await browser.title();
  const url = await browser.url();
  const loggedIn = await resolveSemantic((e) => browser.page.eval(e, false), SEMANTIC.LOGGED_IN_MARKER);
  const onDesign = String(url || "").includes("/design");
  console.log(JSON.stringify({ running: true, cdpPort: browser.cdpPort, url, title, loggedIn: loggedIn.matched, onDesignPage: onDesign }, null, 2));
  return 0;
}

async function cmdInspect(opts) {
  const browser = makeBrowser(opts);
  if (!(await browser.isRunning())) {
    console.log("browser not running — run `start` first");
    return 1;
  }
  await browser.connect();
  const report = {};
  for (const name of Object.values(SEMANTIC)) {
    report[name] = await inspectAll((e) => browser.page.eval(e, false), name);
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

async function cmdScreenshot(opts) {
  const browser = makeBrowser(opts);
  if (!(await browser.isRunning())) {
    console.log("browser not running — run `start` first");
    return 1;
  }
  await browser.connect();
  const b64 = await browser.screenshotBase64("png");
  const out = resolvePath(opts.out || "claude-design-screenshot.png");
  writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(out);
  return 0;
}

async function cmdPrompt(opts) {
  const browser = makeBrowser(opts);
  const brief = opts.positional.join(" ").trim();
  if (!brief) {
    console.error("prompt/create requires a non-empty brief");
    return 1;
  }
  if (!(await browser.isRunning())) await openDesign(browser);
  else await browser.connect();

  const authed = await ensureAuthenticated(browser);
  if (!authed) {
    console.error("not authenticated — no usable desktop session; log in manually in the dedicated window, then retry");
    return 1;
  }

  const input = await resolveSemantic((e) => browser.page.eval(e, false), SEMANTIC.DESIGN_PROMPT_INPUT);
  if (!input.matched) {
    console.error("could not locate the design prompt input (selectors may be stale — run `inspect`)");
    return 1;
  }

  const focusAndTypeExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(input.selector)});
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, ${JSON.stringify(brief)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = ${JSON.stringify(brief)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  })()`;
  const typed = await browser.page.eval(focusAndTypeExpr, false);
  if (!typed) {
    console.error("failed to type into the design prompt input");
    return 1;
  }

  const send = await resolveSemantic((e) => browser.page.eval(e, false), SEMANTIC.DESIGN_SEND_BUTTON);
  if (send.matched) {
    await browser.page.eval(`document.querySelector(${JSON.stringify(send.selector)})?.click()`, false);
  } else {
    // Fallback: dispatch Enter on the focused input.
    await browser.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
    await browser.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  }
  console.log(`prompt sent to Claude Design: ${JSON.stringify(brief)}`);
  return 0;
}

async function cmdSync() {
  // Optional path per plan: official Claude Code CLI owns /design-sync end to
  // end (repo push, no browser automation). This CLI never re-implements it.
  const r = spawnSync("claude", ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "/design-sync"], {
    stdio: "inherit",
  });
  if (r.error) {
    console.error(`claude executable not found or failed: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

async function main(argv) {
  const { command, options, error } = parseArgs(argv);

  // Unknown/missing command, or a bad-arg error on a command that has no
  // options-dependent work to attempt (everything except prompt/create,
  // whose own handler re-validates and reports precisely).
  if (!command || (error && command !== "prompt" && command !== "create")) {
    console.error(error || usage());
    console.error(usage());
    return 1;
  }

  switch (command) {
    case "doctor":
      return cmdDoctor();
    case "start":
    case "open":
      return cmdStart(options);
    case "status":
      return cmdStatus(options);
    case "inspect":
      return cmdInspect(options);
    case "screenshot":
      return cmdScreenshot(options);
    case "prompt":
    case "create":
      if (error) {
        console.error(error);
        return 1;
      }
      return cmdPrompt(options);
    case "sync":
      return cmdSync();
    default:
      console.error(usage());
      return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (e) => {
      console.error(e && e.stack ? e.stack : String(e));
      process.exit(1);
    },
  );
}

export { main, makeBrowser, ensureAuthenticated, openDesign };
