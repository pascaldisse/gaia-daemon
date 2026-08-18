import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  createUser,
  findUserByUsername,
  issueSessionToken,
  listUsers,
  removeUser,
  verifySessionToken,
} from "../src/domain/users.js";

function withGaiaHome(fn: (home: string) => void): void {
  const previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = mkdtempSync(join(tmpdir(), "gaia-users-test-"));
  try {
    fn(process.env.GAIA_HOME);
  } finally {
    if (previous === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previous;
  }
}

test("missing file lists no users", () => {
  withGaiaHome(() => {
    assert.deepEqual(listUsers(), []);
  });
});

test("createUser round-trips + never leaks the hash", () => {
  withGaiaHome(() => {
    const created = createUser("Alice", "correct horse battery staple", "Alice A.");
    assert.equal(created.username, "Alice");
    assert.equal(created.displayName, "Alice A.");
    assert.ok(created.id.startsWith("u_"));
    assert.equal((created as unknown as { passwordHash?: string }).passwordHash, undefined);

    const listed = listUsers();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
  });
});

test("duplicate username (case-insensitive) throws", () => {
  withGaiaHome(() => {
    createUser("bob", "hunter2xxxxxx");
    assert.throws(() => createUser("BOB", "somethingelse"), /already exists/);
  });
});

test("empty username or password throws", () => {
  withGaiaHome(() => {
    assert.throws(() => createUser("", "somepassword"), /username required/);
    assert.throws(() => createUser("carol", ""), /password required/);
  });
});

test("authenticate: right password ok, wrong password/username null, never distinguishes", () => {
  withGaiaHome(() => {
    createUser("dave", "swordfish-123");
    assert.equal(authenticate("dave", "swordfish-123")?.username, "dave");
    assert.equal(authenticate("dave", "wrong"), null);
    assert.equal(authenticate("nobody", "swordfish-123"), null);
    // case-insensitive lookup by username, exact-match password
    assert.equal(authenticate("DAVE", "swordfish-123")?.username, "dave");
  });
});

test("removeUser: true then false, and removed user can no longer authenticate", () => {
  withGaiaHome(() => {
    const user = createUser("erin", "letmein12345");
    assert.equal(removeUser(user.id), true);
    assert.equal(removeUser(user.id), false);
    assert.equal(findUserByUsername("erin"), undefined);
    assert.equal(authenticate("erin", "letmein12345"), null);
  });
});

test("session token: issue -> verify round-trips to the right user", () => {
  withGaiaHome(() => {
    const user = createUser("frank", "opensesame999");
    const token = issueSessionToken(user.id);
    const verified = verifySessionToken(token);
    assert.equal(verified?.id, user.id);
    assert.equal(verified?.username, "frank");
  });
});

test("session token: tampered payload/signature rejected", () => {
  withGaiaHome(() => {
    const user = createUser("grace", "topsecret4567");
    const token = issueSessionToken(user.id);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const tampered = Buffer.from(decoded.replace(user.id, "u_someoneelseid00000"), "utf8").toString("base64url");
    assert.equal(verifySessionToken(tampered), null);
    assert.equal(verifySessionToken("not-a-real-token"), null);
    assert.equal(verifySessionToken(""), null);
  });
});

test("session token: revoked (removed) user stops authenticating even with a live token", () => {
  withGaiaHome(() => {
    const user = createUser("hank", "hunter123456");
    const token = issueSessionToken(user.id);
    assert.ok(verifySessionToken(token));
    removeUser(user.id);
    assert.equal(verifySessionToken(token), null);
  });
});

test("session secret persists across calls within the same GAIA_HOME (two tokens for the same user both verify)", () => {
  withGaiaHome(() => {
    const user = createUser("ivy", "correcthorse7");
    const tokenA = issueSessionToken(user.id);
    const tokenB = issueSessionToken(user.id);
    assert.equal(verifySessionToken(tokenA)?.id, user.id);
    assert.equal(verifySessionToken(tokenB)?.id, user.id);
  });
});
