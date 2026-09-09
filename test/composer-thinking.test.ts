// Live UI regression: app-spawn.js → GAIA_TEST_CDP_PORT=<owned port> bun test test/composer-thinking.test.ts
// Real daemon/data; exact worktree composer assets via CDP Fetch. Never user's native window.
import { test } from "bun:test";
import assert from "node:assert/strict";

const port = process.env.GAIA_TEST_CDP_PORT;
test.skipIf(!port)("reasoning right-click opens visible, hit-testable levels at desktop and narrow widths", async () => {
  assert.notEqual(port, "9333", "Use an owned app-spawn browser, never the live native window");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
  const target = targets.find(t => t.type === "page");
  assert.ok(target);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  const served = new Set<string>();
  let id = 0;
  function send(method: string, params: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  }
  ws.addEventListener("message", async event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id) {
      const task = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) task?.reject(new Error(JSON.stringify(msg.error)));
      else task?.resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args);
    else if (msg.method === "Fetch.requestPaused") {
      try {
        const pathname = new URL(msg.params.request.url).pathname;
        const asset = pathname === "/src/composer.js" ? "../web/src/composer.js" : "../web/src/css/composer.css";
        const body = await Bun.file(new URL(asset, import.meta.url)).text();
        served.add(pathname);
        await send("Fetch.fulfillRequest", {
          requestId: msg.params.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: pathname.endsWith(".css") ? "text/css" : "text/javascript" }],
          body: Buffer.from(body).toString("base64"),
        });
      } catch (error) { errors.push(String(error)); }
    }
  });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("CDP connection failed")); });
  async function evaluate(expression: string) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await Bun.sleep(100);
    }
    assert.fail(`Timed out: ${expression}`);
  }
  async function click(selector: string, button = "left") {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}})()`);
    assert.ok(point?.hit, `Control not hit-testable: ${selector}: ${JSON.stringify(point)}`);
    const { x, y } = point;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
  }
  try {
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/composer.js" }, { urlPattern: "*/src/css/composer.css" }] });
    await send("Page.reload", { ignoreCache: true });
    await waitFor('Boolean(document.querySelector(".thinking-toggle"))');
    for (const width of [1180, 390]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 820, deviceScaleFactor: 1, mobile: false });
      // Desktop: both panes visible. Phone: dismiss the responsive overlays.
      await evaluate(`(async()=>{const m=await import('/src/chrome.js');const {state}=await import('/src/state.js');if(m.isOverlayLayout())m.closeOverlays();else{if(state.sidebarCollapsed)m.toggleSidebar();if(state.rightCollapsed)m.togglePanel();}})()`);
      await Bun.sleep(250);
      await click(".thinking-toggle", "right");
      await waitFor('Boolean(document.querySelector(".thinking-menu button"))');
      const levels = await evaluate(`Array.from(document.querySelectorAll('.thinking-menu button'),e=>{const r=e.getBoundingClientRect();return {level:e.textContent,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}})`);
      console.log(JSON.stringify({ width, levels }));
      if (process.env.GAIA_TEST_PROOF_DIR) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        await Bun.write(`${process.env.GAIA_TEST_PROOF_DIR}/reasoning-${width}.png`, Buffer.from(shot.data, "base64"));
      }
      assert.ok(levels.length > 0);
      assert.ok(levels.every((level: any) => level.hit), `Clipped/covered reasoning levels: ${JSON.stringify(levels)}`);
      await click(".command-input");
      await waitFor('!document.querySelector(".thinking-menu")');
      // A second genuine right-click must reopen, not lose the menu on pointerdown.
      await click(".thinking-toggle", "right");
      await waitFor('Boolean(document.querySelector(".thinking-menu"))');
      await click(".command-input");
      await waitFor('!document.querySelector(".thinking-menu")');
    }
    assert.deepEqual([...served].sort(), ["/src/composer.js", "/src/css/composer.css"].sort());
    assert.deepEqual(errors, [], "Browser console/runtime errors");
  } finally {
    await send("Fetch.disable");
    ws.close();
  }
}, 30_000);
