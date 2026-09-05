// ADVERSARY audit (L3 assignment, 2026-08-18) — PoC-as-tests for src/domain/users.ts
// + src/core/http.ts + src/server/http.ts auth surface. These assert the SECURE
// behavior; they are currently RED against the audited code (see room report).
// Fix is out of scope for this ghoul (審=検, 非=修正) — left for the target agent.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { authenticate, createUser } from "../src/domain/users.js";
import { cookieHeader } from "../src/core/http.js";
import { registerHarness } from "../src/harness/spec.js";
import { GaiaWebServer } from "../src/server/http.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { createTempDir } from "./helpers/temp.js";

function withGaiaHome(fn: (home: string) => void): void {
  const previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = mkdtempSync(join(tmpdir(), "gaia-auth-adv-test-"));
  try {
    fn(process.env.GAIA_HOME);
  } finally {
    if (previous === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previous;
  }
}

// --- L1: login timing oracle -------------------------------------------------
// authenticate() short-circuits to `null` with NO scrypt call when the
// username doesn't exist, but runs a full scryptSync when it does (right
// user, wrong password). That's a wall-clock side channel an attacker can use
// to enumerate valid usernames — contradicts the "never distinguish which"
// doc comment on authenticate(). Measured live 2026-08-18: existing-user path
// median ~30ms vs nonexistent-user path median ~1.6ms (~18x, well outside
// noise). Threshold below is generous (3x) precisely so it still fails hard
// against the current code without being timing-flaky in CI.
test("L1 SECURITY: authenticate() must not leak username existence via timing", () => {
  withGaiaHome(() => {
    createUser("timing-victim", "correcthorsebatterystaple123");
    const N = 25;
    const existingTimes: number[] = [];
    const missingTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      authenticate("timing-victim", "definitely-wrong-password");
      existingTimes.push(performance.now() - t0);

      const t1 = performance.now();
      authenticate("no-such-user-xyz", "definitely-wrong-password");
      missingTimes.push(performance.now() - t1);
    }
    const median = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const existingMedian = median(existingTimes);
    const missingMedian = median(missingTimes);
    assert.ok(
      existingMedian < missingMedian * 3 + 2,
      `timing oracle: existing-user median ${existingMedian.toFixed(2)}ms vs ` +
        `nonexistent-user median ${missingMedian.toFixed(2)}ms (ratio ${(existingMedian / Math.max(missingMedian, 0.001)).toFixed(1)}x) ` +
        `— username enumeration via response latency.`,
    );
  });
});

// --- L2: scrypt cost parameters below OWASP minimum -------------------------
// hashPassword() calls scryptSync(password, salt, 64) with NO explicit N/r/p —
// Node defaults to N=16384 (2^14), r=8, p=1. OWASP Password Storage Cheat
// Sheet's lowest acceptable tier is N=2^15 (32768); recommended is N=2^17
// with maxmem raised. We prove the ACTUAL cost used (not just measure time):
// re-derive the stored hash deterministically with N=16384 and byte-compare.
test("L2 SECURITY: password hash cost must be at least OWASP-minimum (N>=2^15), not Node's bare default N=2^14", () => {
  withGaiaHome((home) => {
    createUser("cost-victim", "correcthorsebatterystaple123");
    const raw = JSON.parse(readFileSync(join(home, "users.json"), "utf8")) as { users: Array<{ passwordHash: string }> };
    const stored = raw.users[0].passwordHash;
    const [scheme, salt, hashHex] = stored.split("$");
    assert.equal(scheme, "scrypt");
    const storedBuf = Buffer.from(hashHex, "hex");

    // Reproduce with Node's bare default cost (N=16384,r=8,p=1) — if this
    // matches the stored hash, the code is provably running at the weak
    // default, not an explicit OWASP-tier cost.
    const atDefault = scryptSync("correcthorsebatterystaple123", salt, storedBuf.length, { N: 16384, r: 8, p: 1 });
    const matchesWeakDefault = Buffer.compare(atDefault, storedBuf) === 0;

    assert.equal(
      matchesWeakDefault,
      false,
      "hashPassword() derives with Node's bare default cost N=16384 (2^14), below OWASP's minimum " +
        "acceptable tier N=2^15 (32768) for scrypt password storage — offline cracking risk if users.json leaks.",
    );
  });
});

// --- L3: session cookie missing Secure attribute -----------------------------
// cookieHeader() sets HttpOnly + SameSite=Lax + Path=/ but never `Secure`.
// The daemon itself is plain node:http (no TLS anywhere in src/server/http.ts)
// and GAIA_BASE_PATH's own doc names non-TLS-terminating reverse proxies as a
// supported deployment shape — so this 30-day session credential has no
// protocol-downgrade defense-in-depth at all.
test("L3 SECURITY: session cookie must carry the Secure attribute", () => {
  const header = cookieHeader("gaia_user", "some-token-value", 30 * 24 * 60 * 60);
  assert.match(header, /(^|;\s*)Secure(;|$)/i, `Set-Cookie header missing Secure: "${header}"`);
});

// --- L5: logout does not revoke a token an attacker already holds -----------
// issueSessionToken/verifySessionToken are pure stateless HMAC — there is no
// server-side session table. POST /api/auth/logout only clears the CLIENT
// cookie; it never invalidates the token itself. A token exfiltrated before
// logout (XSS, the L3 cleartext-cookie path, shoulder-surfed devtools, etc.)
// keeps authenticating for the full 30-day TTL regardless of the user
// explicitly logging out. (Contrast: removeUser() DOES immediately invalidate
// — verified as a live control, not asserted here.)
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
  ui: { label: "auth-adversarial test harness", description: "unused, satisfies registry lookups" },
  create: () => {
    throw new Error("not used: this test never starts an agent turn");
  },
});

type WebInternals = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  daemon: { dispose(): Promise<void> };
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
  return { server, baseUrl: `http://127.0.0.1:${(address as { port: number }).port}` };
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeAllConnections?.();
}

test("L5 SECURITY: logout must revoke the session token server-side, not just clear the client cookie", async () => {
  const temp = await createTempDir();
  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  let server: HttpServer | undefined;
  try {
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);

    const web = new GaiaWebServer({ cwd: workspace }) as unknown as WebInternals;
    const listening = await listenRoute(web);
    server = listening.server;

    // First user ever created on this fresh GAIA_HOME bootstraps with no
    // auth required (see /api/auth/users route comment).
    const createRes = await fetch(`${listening.baseUrl}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "logout-victim", password: "correcthorsebatterystaple123" }),
    });
    assert.equal(createRes.status, 200, await createRes.text());

    const login = await fetch(`${listening.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "logout-victim", password: "correcthorsebatterystaple123" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const stolenCookie = /gaia_user=([^;]+)/.exec(setCookie)?.[1];
    assert.ok(stolenCookie, `no gaia_user cookie in Set-Cookie: "${setCookie}"`);

    // Attacker exfiltrates the raw token here (out of band — XSS, cleartext
    // transit per L3, etc.) BEFORE the legitimate user logs out.
    const meBefore = await fetch(`${listening.baseUrl}/api/auth/me`, {
      headers: { cookie: `gaia_user=${stolenCookie}` },
    });
    assert.equal((await meBefore.json() as { user: { username: string } | null }).user?.username, "logout-victim");

    const logout = await fetch(`${listening.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: `gaia_user=${stolenCookie}` },
    });
    assert.equal(logout.status, 200);

    // Replay the STOLEN (pre-logout) token — must now be dead.
    const meAfter = await fetch(`${listening.baseUrl}/api/auth/me`, {
      headers: { cookie: `gaia_user=${stolenCookie}` },
    });
    const afterUser = (await meAfter.json() as { user: { username: string } | null }).user;
    assert.equal(
      afterUser,
      null,
      `stolen token still authenticates as ${JSON.stringify(afterUser)} after the victim logged out — ` +
        `logout only clears the client cookie, never revokes the token server-side.`,
    );
  } finally {
    if (server) await closeServer(server);
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }
});
