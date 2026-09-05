import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, issueSessionToken, revokeSessionToken, verifySessionToken } from "../src/domain/users.js";

function isolated(fn: (home: string, userId: string) => void): void {
  const previous = process.env.GAIA_HOME;
  const home = mkdtempSync(join(tmpdir(), "gaia-auth-revoke-"));
  process.env.GAIA_HOME = home;
  try { fn(home, createUser("alice", "password").id); }
  finally {
    if (previous === undefined) delete process.env.GAIA_HOME; else process.env.GAIA_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("revocation: independent sessions at identical timestamps; replay denied after process restart", () => isolated((home, userId) => {
  const clock = Date.now;
  const now = clock();
  let first: string;
  let second: string;
  Date.now = () => now;
  try { first = issueSessionToken(userId); second = issueSessionToken(userId); }
  finally { Date.now = clock; }
  assert.notEqual(first, second);
  revokeSessionToken(first);
  assert.equal(verifySessionToken(first), null);
  assert.equal(verifySessionToken(second)?.id, userId);
  assert.equal(statSync(join(home, "session-revocations.json")).mode & 0o777, 0o600);
  const child = spawnSync(process.execPath, ["--eval", `
    import { verifySessionToken } from ${JSON.stringify(new URL("../src/domain/users.ts", import.meta.url).href)};
    console.log(JSON.stringify([verifySessionToken(${JSON.stringify(first)}), verifySessionToken(${JSON.stringify(second)})?.id]));
  `], { env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [null, userId]);
}));

test("revocation: canonical signature blocks alternate encodings and legacy nonce-less tokens", () => isolated((home, userId) => {
  issueSessionToken(userId); // Initialize the signing secret.
  const payload = `${userId}.${Date.now() + 60000}`;
  const signature = createHmac("sha256", Buffer.from(readFileSync(join(home, "session-secret"), "utf8").trim(), "hex")).update(payload).digest("hex");
  const token = Buffer.from(`${payload}.${signature}`).toString("base64url");
  const alternate = Buffer.from(`${payload}.${signature.toUpperCase()}`).toString("base64");
  assert.equal(verifySessionToken(token)?.id, userId);
  assert.equal(verifySessionToken(alternate)?.id, userId);
  revokeSessionToken(token);
  assert.equal(verifySessionToken(token), null);
  assert.equal(verifySessionToken(alternate), null);
  revokeSessionToken(alternate); // Idempotent logout.
  assert.equal(Object.keys(JSON.parse(readFileSync(join(home, "session-revocations.json"), "utf8"))).length, 1);
}));

test("revocation: expired entries pruned; corrupt ledger fails closed", () => isolated((home, userId) => {
  const path = join(home, "session-revocations.json");
  const token = issueSessionToken(userId);
  writeFileSync(path, JSON.stringify({ ["0".repeat(64)]: Date.now() - 1 }));
  revokeSessionToken(token);
  assert.equal(JSON.parse(readFileSync(path, "utf8"))["0".repeat(64)], undefined);
  const fresh = issueSessionToken(userId);
  writeFileSync(path, "corrupt");
  assert.equal(verifySessionToken(fresh), null);
  assert.throws(() => revokeSessionToken(fresh));
}));
