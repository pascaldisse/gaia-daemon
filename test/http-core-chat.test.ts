import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { GaiaWebServer } from "../src/server/http.js";

type Listener = (event: { type: string; taskId?: string; delta?: string; task?: { id: string } }) => void;
type WebInternals = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  daemon: {
    activeCall: undefined;
    defaultWorkspaceId(): Promise<string>;
    defaultWorkspaceAgentIds(): Promise<string[]>;
    serviceFor(workspaceId: string, roomId: string): Promise<unknown>;
    dispose(): Promise<void>;
  };
};

async function listenRoute(web: WebInternals): Promise<{ server: HttpServer; base: string }> {
  const server = createServer((request, response) => void web.handle(request, response));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("headless chat targets one agent, streams its fake runtime reply, and ignores request history", async () => {
  const web = new GaiaWebServer({ cwd: process.cwd() }) as unknown as WebInternals;
  const sent: Array<{ message: string; options: unknown }> = [];
  const fakeRuntime = {
    async *send(): AsyncIterable<{ type: "text-delta"; delta: string }> {
      yield { type: "text-delta", delta: "CORE" };
      yield { type: "text-delta", delta: " reply" };
    },
  };
  const service = {
    workspace: { agents: { luna: {} } },
    activeTaskId: undefined,
    async waitForIdle() {},
    async sendMessage(message: string, options: unknown) {
      sent.push({ message, options });
      return { id: "fake-task" };
    },
    subscribe(listener: Listener) {
      void (async () => {
        for await (const event of fakeRuntime.send()) listener({ ...event, taskId: "fake-task" });
        listener({ type: "task-end", task: { id: "fake-task" } });
      })();
      return () => {};
    },
    async cancelActiveTask() {},
    async runClearCommand() {},
  };
  web.daemon.defaultWorkspaceId = async () => "cwd-workspace";
  web.daemon.defaultWorkspaceAgentIds = async () => ["luna"];
  web.daemon.serviceFor = async (workspaceId: string, roomId: string) => {
    assert.equal(workspaceId, "cwd-workspace");
    assert.equal(roomId, "copilot");
    return service;
  };
  const { server, base } = await listenRoute(web);
  try {
    const models = await fetch(`${base}/v1/models`);
    assert.deepEqual(await models.json(), { object: "list", data: [{ id: "luna", object: "model", created: 0, owned_by: "gaia" }] });
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "luna@copilot", stream: true, messages: [{ role: "user", content: "ignored old turn" }, { role: "assistant", content: "ignored" }, { role: "user", content: "new turn" }] }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"CORE"/);
    assert.match(text, /"content":" reply"/);
    assert.match(text, /"model":"luna"/);
    assert.match(text, /data: \[DONE\]/);
    assert.deepEqual(sent, [{ message: "new turn", options: { targets: ["luna"], channel: "chat", recordUserMessage: true } }]);
    const unavailable = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "no model" }] }) });
    assert.equal(unavailable.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await web.daemon.dispose();
  }
});
