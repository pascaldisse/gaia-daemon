import { jsonGet, cdpClient } from "./cdp-lib.mjs";
import { readFileSync } from "node:fs";

const targetId = readFileSync("/tmp/cdp-tab-id", "utf8").trim();
const selector = process.argv[2];
const index = Number(process.argv[3] ?? 0);

const list = await jsonGet("/json/list");
const tab = list.find((t) => t.id === targetId);
if (!tab) throw new Error("tab not found");
const client = cdpClient(tab.webSocketDebuggerUrl);
await client.send("Runtime.enable");
await client.send("Input.enable");

const rectRes = await client.send("Runtime.evaluate", {
  expression: `(async () => { const els = document.querySelectorAll(${JSON.stringify(selector)}); const el = els[${index}]; if (!el) return null; el.scrollIntoView({ block: "center" }); await new Promise(r => setTimeout(r, 500)); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
  returnByValue: true,
  awaitPromise: true,
});
const point = rectRes.result?.result?.value;
if (!point) throw new Error("element not found: " + selector + " [" + index + "]");

await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });

console.log("clicked (trusted) at", point);
client.ws.close();
process.exit(0);
