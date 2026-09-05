import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticate, createUser } from "../src/domain/users.js";

function isolated(fn: (path: string) => void): void {
  const home = process.env.GAIA_HOME;
  const cost = process.env.GAIA_SCRYPT_N;
  const dir = mkdtempSync(join(tmpdir(), "gaia-auth-cost-"));
  process.env.GAIA_HOME = dir;
  delete process.env.GAIA_SCRYPT_N;
  try { fn(join(dir, "users.json")); }
  finally {
    if (home === undefined) delete process.env.GAIA_HOME; else process.env.GAIA_HOME = home;
    if (cost === undefined) delete process.env.GAIA_SCRYPT_N; else process.env.GAIA_SCRYPT_N = cost;
    rmSync(dir, { recursive: true, force: true });
  }
}

function readUsers(path: string): { users: Array<{ passwordHash: string }> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertCost(stored: string, password: string, N: number): void {
  const [scheme, salt, hash, cost] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.equal(Number(cost), N);
  assert.equal(hash, scryptSync(password, salt, 64, { N, r: 8, p: 1, maxmem: 128 * N * 8 + 1024 * 1024 }).toString("hex"));
}

test("scrypt: default floor derives the actual stored hash", () => isolated((path) => {
  createUser("alice", "password");
  assertCost(readUsers(path).users[0].passwordHash, "password", 32768);
}));

test("scrypt: legacy hashes verify; only successful login upgrades", () => isolated((path) => {
  createUser("alice", "password");
  const data = readUsers(path);
  const salt = "0123456789abcdef0123456789abcdef";
  const legacy = `scrypt$${salt}$${scryptSync("password", salt, 64).toString("hex")}`;
  data.users[0].passwordHash = legacy;
  writeFileSync(path, JSON.stringify(data));
  assert.equal(authenticate("alice", "wrong"), null);
  assert.equal(readUsers(path).users[0].passwordHash, legacy);
  assert.equal(authenticate("alice", "password")?.username, "alice");
  assertCost(readUsers(path).users[0].passwordHash, "password", 32768);
  assert.equal(authenticate("alice", "password")?.username, "alice");
}));

test("scrypt: configured higher floor upgrades existing hashes without later downgrades", () => isolated((path) => {
  createUser("alice", "password");
  process.env.GAIA_SCRYPT_N = "65536";
  assert.equal(authenticate("alice", "password")?.username, "alice");
  assertCost(readUsers(path).users[0].passwordHash, "password", 65536);
  delete process.env.GAIA_SCRYPT_N;
  assert.equal(authenticate("alice", "password")?.username, "alice");
  assertCost(readUsers(path).users[0].passwordHash, "password", 65536);
}));

test("scrypt: invalid or below-floor configuration rejected", () => isolated(() => {
  for (const value of ["16384", "32769", "NaN", "-1"]) {
    process.env.GAIA_SCRYPT_N = value;
    assert.throws(() => createUser("alice", "password"), /GAIA_SCRYPT_N/);
  }
}));

test("scrypt: mixed legacy/current costs cannot distinguish either username from a missing user", () => isolated((path) => {
  createUser("legacy", "password");
  createUser("current", "password");
  const data = readUsers(path);
  const salt = "0123456789abcdef0123456789abcdef";
  data.users[0].passwordHash = `scrypt$${salt}$${scryptSync("password", salt, 64).toString("hex")}`;
  writeFileSync(path, JSON.stringify(data));
  const names = ["legacy", "current", "missing"];
  const samples = names.map(() => [] as number[]);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < names.length; j++) {
      const start = performance.now();
      assert.equal(authenticate(names[j], "wrong"), null);
      samples[j].push(performance.now() - start);
    }
  }
  const medians = samples.map((values) => values.sort((a, b) => a - b)[4]);
  assert.ok(Math.max(...medians) < Math.min(...medians) * 1.75 + 2, `mixed-cost timing medians: ${medians.join(", ")}`);
}));
