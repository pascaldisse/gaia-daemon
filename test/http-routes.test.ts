import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { GaiaWebServer } from "../src/server/http.js";
import { artifactRoutePrefix } from "../src/server/routes/artifacts.js";
import { titleCaseId } from "../src/server/routes/agents.js";
import { stringArrayField } from "../src/server/routes/edit-retry.js";
import { numberField } from "../src/server/routes/memory.js";
import { attachmentRefs } from "../src/server/routes/rooms.js";
import { summonCensusText } from "../src/server/routes/usage.js";
import { createTempDir } from "./helpers/temp.js";

type WebInternals = { handle(request: IncomingMessage, response: ServerResponse): Promise<void>; daemon: { dispose(): Promise<void> } };
async function listenRoute(web: WebInternals): Promise<{ server: HttpServer; base: string }> {
  const server = createServer((request, response) => void web.handle(request, response));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
test("route modules preserve parsing contracts and API auth JSON", async () => {
  assert.equal(titleCaseId("my-agent"), "My Agent");
  assert.deepEqual(stringArrayField({ keepAttachments: [] }, "keepAttachments"), []);
  assert.equal(numberField({ limit: 3 }, "limit"), 3);
  assert.deepEqual(attachmentRefs({ attachments: [{ id: "file-1", name: "x" }] }), [{ id: "file-1", name: "x" }]);
  assert.equal(summonCensusText([]), "No summon lanes found.");
  assert.equal(artifactRoutePrefix, "/api/harness/tools");
  const temp = await createTempDir();
  const web = new GaiaWebServer({ cwd: temp.path }) as unknown as WebInternals;
  const { server, base } = await listenRoute(web);
  try {
    const response = await fetch(`${base}/api/auth/users`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Not logged in." });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await web.daemon.dispose();
    await temp.cleanup();
  }
});
