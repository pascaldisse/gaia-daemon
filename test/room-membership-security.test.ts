// ADVERSARIAL AUDIT (see room ghoul-sonnet-msymjojessxni5, 2026-08-18): proves
// three room-membership (RoomState.humans) enforcement gaps against the REAL
// GaiaWebServer/http.ts routes and the REAL daemon.broadcast() SSE fan-out —
// not a hand-rolled smoke script. Every test here is RED (fails its
// "membership enforced" assertion) against the current tree, demonstrating
// the vulnerability is live. No fix is applied in this file — see the audit
// report for remediation specs. Do not "fix" these tests to make them pass
// without also fixing src/server/http.ts; that would hide the bug.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RoomHandle } from "../src/domain/rooms.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { registerHarness } from "../src/harness/spec.js";
import { GaiaWebServer } from "../src/server/http.js";
import { createUser, issueSessionToken } from "../src/domain/users.js";
import { createTempDir } from "./helpers/temp.js";
import type { UiEvent } from "../src/core/types.js";

// Every harness (Pi included) runs via a per-(room,agent) subprocess spawned
// by RunnerHost (src/harness/host.ts createAgentRuntime) — the harness spec's
// own create() only ever runs INSIDE that child. RoomService construction
// still resolves harnessSpecFor("pi") eagerly for capabilities metadata, so a
// capabilities-only stub is required even though none of these tests ever
// POST /messages / start a real turn (no subprocess is ever spawned here).
registerHarness({
  id: "pi",
  capabilities: {
    gaiaTools: [],
    nativeTools: [],
    granularTools: true,
    supportsPermissionMode: false,
    supportsMcp: false,
    supportsSteer: false,
    supportsCompact: false,
    supportsNativeCommands: false,
    fanOutTools: [],
  },
  ui: { label: "membership-audit stub", description: "capabilities-only stub; never invoked (no turn is started)" },
  create: () => {
    throw new Error("not used: these tests never start a real agent turn");
  },
});

type WebInternals = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  daemon: {
    registry: { add(path: string): Promise<{ id: string }> };
    broadcast(event: UiEvent): void;
    dispose(): Promise<void>;
  };
};

async function listenRoute(web: WebInternals): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = createServer((request, response) => {
    void web.handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  // Observed under bun test (bun 1.3.14): node:http's server.close() callback
  // can fail to fire on an idle http server (zero in-flight requests) — a bun
  // node:http-compat gap, not anything about the routes under test (every
  // assertion above already ran and settled by this point). closeAllConnections()
  // synchronously tears the listener down (close() then throws
  // ERR_SERVER_NOT_RUNNING, expected/harmless); a bounded race is the fallback
  // for whatever bun version doesn't. Either way, teardown never blocks or
  // masks the actual security assertions.
  server.closeAllConnections?.();
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Server is not running.") throw error;
  }
}

async function withHarness<T>(fn: () => Promise<T>): Promise<T> {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  let web: WebInternals | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);
    web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const record = await web.daemon.registry.add(workspace);
    const listening = await listenRoute(web);
    server = listening.server;
    return await fn.call(null, { baseUrl: listening.baseUrl, workspaceId: record.id, workspace, web } as unknown as T);
  } finally {
    if (server) await closeServer(server);
    await web?.daemon.dispose();
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
    await temp.cleanup();
  }
}

function cookieFor(userId: string): string {
  return `gaia_user=${issueSessionToken(userId)}`;
}

// --- L1: live SSE fan-out (GaiaWebServer.broadcast, the /api/events source) --
// ignores RoomState.humans entirely. It only compares the CLIENT'S OWN
// self-declared ?workspaceId/?roomId query params against the event's tags —
// no server-side membership check ever runs on this path, even though the
// paired REST reads (GET .../events, POST .../messages) DO enforce it. Root
// cause: src/server/http.ts private broadcast() (~L1893) fan-out loop.
test("SECURITY [FAIL, HIGH]: anonymous SSE client receives room-event content from a members-only room (L1)", async () => {
  await withHarness(async (ctx: any) => {
    const { baseUrl, workspaceId, workspace, web } = ctx;
    // Room "secret1" is membership-restricted to one human who is NOT the
    // caller below — REST reads/writes on this room 403 for anyone else.
    const room = await RoomHandle.open(workspace, "secret1");
    await room.updateState((state) => {
      state.humans = ["u_alice_only"];
    });

    // Sanity: the REST paging route DOES enforce membership for this room.
    const restRead = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/secret1/events`);
    assert.equal(restRead.status, 403, "control check: REST /events must 403 anonymous reads on a gated room");

    // Attacker: anonymous (no cookie) SSE subscription, self-declaring the
    // gated room's workspaceId/roomId — nothing server-side validates that
    // declaration against RoomState.humans.
    const sseController = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events?workspaceId=${workspaceId}&roomId=secret1`, {
      signal: sseController.signal,
    });
    assert.equal(sseResponse.status, 200, "SSE endpoint accepts anonymous connections at all (no auth gate)");
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    const readLoop = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          collected += decoder.decode(value, { stream: true });
          if (collected.includes("TOP-SECRET-PAYLOAD")) break;
        }
      } catch {
        // aborted — expected on cleanup
      }
    })();

    // Give the SSE connection a beat to register with the client set, then
    // fire the EXACT same broadcast() production code path a real committed
    // message in "secret1" would trigger (service.subscribe -> daemon.broadcast
    // -> GaiaWebServer.broadcast -> per-client fan-out, http.ts ~L1893).
    await new Promise((resolve) => setTimeout(resolve, 150));
    web.daemon.broadcast({
      type: "room-event",
      workspaceId,
      roomId: "secret1",
      event: {
        id: "evt_secret_1",
        timestamp: new Date().toISOString(),
        author: "user",
        targets: ["gaia"],
        text: "TOP-SECRET-PAYLOAD-alice-only",
        humanId: "u_alice_only",
        humanLabel: "Alice",
      },
    } as UiEvent);

    await Promise.race([readLoop, new Promise((resolve) => setTimeout(resolve, 2000))]);
    sseController.abort();
    await readLoop.catch(() => {});

    // THE ASSERTION THAT SHOULD HOLD (and currently does NOT): an anonymous,
    // non-member client must never see this room's content over SSE, exactly
    // as it cannot over the REST /events route above.
    assert.equal(
      collected.includes("TOP-SECRET-PAYLOAD-alice-only"),
      false,
      "VULNERABLE: anonymous SSE client received members-only room content — live read-enforcement bypass",
    );
  });
});

// --- L4: bootstrap invite land-grab -----------------------------------------
// POST .../humans allows ANY authenticated user to self-invite into an empty
// (unrestricted) room's allowlist. Once done, every OTHER user — including
// one who was actively using that room seconds earlier — is permanently
// locked out (403 on read, write, AND on adding themselves back, since they
// are now "not a member"). Root cause: src/server/http.ts POST .../humans
// gate `existing.length > 0 && !existing.includes(requester.id)` treats
// "room has zero members" as "anyone may bootstrap ownership", with no
// distinction between "a legitimate first owner" and "a stranger racing to
// grab a room someone else already relies on".
test("SECURITY [FAIL, HIGH]: any authenticated user can bootstrap-invite themselves into an open room and permanently lock out the room's actual prior user (L4)", async () => {
  await withHarness(async (ctx: any) => {
    const { baseUrl, workspaceId } = ctx;
    const { workspace } = ctx;
    const alice = createUser("alice-l4", "pw", "Alice");
    const bob = createUser("bob-l4", "pw", "Bob");
    const aliceCookie = cookieFor(alice.id);
    const bobCookie = cookieFor(bob.id);

    // "default" room starts unrestricted (humans: [] absent) — today's default
    // for every pre-existing/never-gated room.
    const before = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/default/humans`, {
      headers: { cookie: aliceCookie },
    });
    assert.deepEqual((await before.json()).humans, []);

    // Alice actively uses the room while it's open (any authenticated user may
    // read/post here today — seed the transcript directly, equivalent to a
    // committed POST /messages, to prove real prior use without spawning a
    // real agent turn through RunnerHost).
    const room = await RoomHandle.open(workspace, "default");
    await room.addUserMessage("alice was here first", ["gaia"], undefined, undefined, undefined, { id: alice.id, label: "Alice" });
    const aliceReadBefore = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/default/events`, {
      headers: { cookie: aliceCookie },
    });
    assert.equal(aliceReadBefore.status, 200, "alice can read the open room before anyone claims it");

    // Bob — a stranger with zero prior claim to this room, just an account —
    // bootstrap-invites ONLY himself because the room currently has no members.
    const grab = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/default/humans`, {
      method: "POST",
      headers: { cookie: bobCookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: bob.id }),
    });
    assert.equal(grab.status, 200);
    assert.deepEqual(new Set((await grab.json()).humans), new Set([alice.id, bob.id]), "bootstrap retains prior authenticated participants");

    // Alice, who was using this room seconds ago, is now locked out of every
    // surface: read AND self-re-invite (POST/GET 403 enforcement itself is
    // already covered by L2/L3 — this proves the LOCKOUT is total/unrecoverable).
    const aliceReadAfter = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/default/events`, {
      headers: { cookie: aliceCookie },
    });
    const aliceReinviteSelf = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/default/humans`, {
      method: "POST",
      headers: { cookie: aliceCookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: alice.id }),
    });

    // THE ASSERTIONS THAT SHOULD HOLD (and currently do NOT): a stranger
    // self-inviting into a room they never previously had a recognized claim
    // to beyond "the allowlist happened to be empty" must not be able to
    // unilaterally and irrecoverably exclude a room's actual prior user.
    assert.notEqual(aliceReadAfter.status, 403, "VULNERABLE: alice locked out of reading a room she was using");
    assert.notEqual(aliceReinviteSelf.status, 403, "VULNERABLE: alice cannot even self-heal by re-adding herself — total, unrecoverable exclusion");
  });
});

// --- L5: last-member self-removal silently reopens the room ----------------
// removeHuman() on the LAST remaining member does not persist an empty
// allowlist (normalizeRoomState drops empty arrays) — it reverts the room to
// today's "unrestricted" default. A member who leaves a room they believe is
// still private (e.g. removing themselves without realizing they were the
// only member) instantly and silently exposes all prior confidential content
// to anonymous read, with no warning surfaced anywhere in this endpoint.
// Root cause: src/services/room-service.ts removeHuman() `else delete
// state.humans` conflates "no membership restriction was ever configured"
// with "the last configured member just left" — semantically different
// events, identical resulting state.
test("SECURITY [FAIL, MEDIUM, footgun]: removing the last room member silently reopens prior confidential content to anonymous read (L5)", async () => {
  await withHarness(async (ctx: any) => {
    const { baseUrl, workspaceId, workspace } = ctx;
    const alice = createUser("alice-l5", "pw", "Alice");
    const aliceCookie = cookieFor(alice.id);

    const room = await RoomHandle.open(workspace, "secret2");
    await room.addUserMessage("TOP-SECRET-L5-PAYLOAD", ["gaia"], undefined, undefined, undefined, { id: alice.id, label: "Alice" });
    await room.updateState((state) => {
      state.humans = [alice.id];
    });

    const gatedRead = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/secret2/events`);
    assert.equal(gatedRead.status, 403, "control check: room is actually gated before alice leaves");

    // Alice removes herself — the only member. No confirmation, no distinct
    // "this will reopen the room" signal anywhere in the response.
    const leave = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/secret2/humans/${alice.id}`, {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });
    assert.equal(leave.status, 200);
    assert.deepEqual((await leave.json()).humans, []);

    const anonReadAfter = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/rooms/secret2/events`);

    // THE ASSERTION THAT SHOULD HOLD (and currently does NOT): a member
    // leaving must not silently declassify the room's prior confidential
    // content to anonymous read.
    assert.equal(anonReadAfter.status, 403, "VULNERABLE: last-member self-removal reopened a previously-gated room to anonymous read");
  });
});

// Delivery matrix → identity, wildcard subscriptions, open rooms, revocation, ordering.
test("SSE authorizes members and rechecks membership on existing subscriptions", async () => {
  await withHarness(async (ctx: any) => {
    const { baseUrl, workspaceId, workspace, web } = ctx;
    const alice = createUser("sse-alice", "pw", "Alice");
    const bob = createUser("sse-bob", "pw", "Bob");
    const room = await RoomHandle.open(workspace, "sse-private");
    await room.updateState((state) => { state.humans = [alice.id]; });
    const clients: { controller: AbortController; text: string; read: Promise<void> }[] = [];
    try {
      for (const cookie of [undefined, cookieFor(bob.id), cookieFor(alice.id)]) {
        const controller = new AbortController();
        const response = await fetch(`${baseUrl}/api/events`, {
          signal: controller.signal,
          ...(cookie ? { headers: { cookie } } : {}),
        });
        assert.equal(response.status, 200);
        const client = { controller, text: "", read: Promise.resolve() };
        clients.push(client);
        client.read = (async () => {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) return;
              client.text += decoder.decode(value, { stream: true });
            }
          } catch { /* aborted on cleanup */ }
        })();
      }
      const send = (roomId: string, text: string) => web.daemon.broadcast({
        type: "room-event", workspaceId, roomId,
        event: { id: text, timestamp: new Date().toISOString(), author: "system", text },
      });
      const fence = async (account: string) => {
        web.daemon.broadcast({ type: "usage-limits", account, usage: null });
        const deadline = Date.now() + 2000;
        while (!clients.every((client) => client.text.includes(account)) && Date.now() < deadline) await Bun.sleep(10);
        assert.ok(clients.every((client) => client.text.includes(account)), "all delivery queues drained");
      };
      send("sse-private", "PRIVATE-FIRST");
      send("sse-private", "PRIVATE-SECOND");
      send("sse-open", "OPEN-CONTROL");
      await fence("fence-before-revocation");
      for (const client of clients.slice(0, 2)) assert.ok(!client.text.includes("PRIVATE-"));
      assert.ok(clients.every((client) => client.text.includes("OPEN-CONTROL")));
      assert.ok(clients[2]!.text.includes("PRIVATE-FIRST"));
      assert.ok(clients[2]!.text.indexOf("PRIVATE-FIRST") < clients[2]!.text.indexOf("PRIVATE-SECOND"));
      await room.updateState((state) => { state.humans = [bob.id]; });
      send("sse-private", "PRIVATE-AFTER-REVOCATION");
      await fence("fence-after-revocation");
      assert.ok(!clients[0]!.text.includes("PRIVATE-AFTER-REVOCATION"));
      assert.ok(clients[1]!.text.includes("PRIVATE-AFTER-REVOCATION"));
      assert.ok(!clients[2]!.text.includes("PRIVATE-AFTER-REVOCATION"));
    } finally {
      for (const client of clients) client.controller.abort();
      await Promise.all(clients.map((client) => client.read));
    }
  });
});

test("last-member removal persists deny-all and cannot bootstrap back to open", async () => {
  await withHarness(async (ctx: any) => {
    const { baseUrl, workspaceId, workspace } = ctx;
    const alice = createUser("leave-alice", "pw", "Alice");
    const cookie = cookieFor(alice.id);
    const room = await RoomHandle.open(workspace, "leave-private");
    await room.updateState((state) => { state.humans = [alice.id]; });
    const url = `${baseUrl}/api/workspaces/${workspaceId}/rooms/leave-private`;
    assert.equal((await fetch(`${url}/humans/${alice.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
    const reopened = await RoomHandle.open(workspace, "leave-private");
    assert.deepEqual((await reopened.state()).humans, []);
    assert.equal((await fetch(`${url}/events`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${url}/humans`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ userId: alice.id }),
    })).status, 403);
    assert.equal((await fetch(`${url}/humans/${alice.id}`, { method: "DELETE", headers: { cookie } })).status, 403);
    assert.deepEqual((await reopened.state()).humans, []);
  });
});
