import WebSocket from "ws";

const CDP = "http://127.0.0.1:9444";

export async function jsonGet(path) {
  const method = path.startsWith("/json/new") ? "PUT" : "GET";
  const r = await fetch(CDP + path, { method });
  return r.json();
}

export function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  function send(method, params = {}) {
    return ready.then(
      () =>
        new Promise((resolve) => {
          const mid = ++id;
          pending.set(mid, resolve);
          ws.send(JSON.stringify({ id: mid, method, params }));
        }),
    );
  }
  return { send, ws };
}

export async function attachToTab(targetId) {
  const list = await jsonGet("/json/list");
  const tab = list.find((t) => t.id === targetId);
  if (!tab) throw new Error("tab not found: " + targetId);
  const client = cdpClient(tab.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return client;
}

export async function evalInTab(targetId, expression) {
  const client = await attachToTab(targetId);
  const res = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  client.ws.close();
  return res.result;
}
