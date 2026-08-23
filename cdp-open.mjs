import { jsonGet, cdpClient } from "./cdp-lib.mjs";
import { writeFileSync } from "node:fs";

const TOKEN = process.env.RA_TOKEN;
if (!TOKEN) throw new Error("set RA_TOKEN");

const tab = await jsonGet("/json/new?about:blank");
const client = cdpClient(tab.webSocketDebuggerUrl);
await client.send("Page.enable");
await client.send("Runtime.enable");
await client.send("Network.enable");

await client.send("Network.setCookie", {
  name: "gaia_user",
  value: TOKEN,
  domain: "localhost",
  path: "/",
  httpOnly: true,
});

// Install a persistent console/network log buffer BEFORE navigation via an
// injected script that runs on every new document.
await client.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__raLog = [];
    const push = (...a) => window.__raLog.push(a.map(String).join(' '));
    for (const level of ['log','warn','error','info','debug']) {
      const orig = console[level].bind(console);
      console[level] = (...a) => { push('['+level+']', ...a); orig(...a); };
    }
    window.addEventListener('error', (e) => push('[onerror]', e.message, e.filename, e.lineno));
    window.addEventListener('unhandledrejection', (e) => push('[unhandledrejection]', String(e.reason)));
  `,
});

await client.send("Page.navigate", { url: "http://localhost:8787/" });
await new Promise((r) => setTimeout(r, 3000));

writeFileSync("/tmp/cdp-tab-id", tab.id);
console.log("tab id:", tab.id);
client.ws.close();
process.exit(0);
