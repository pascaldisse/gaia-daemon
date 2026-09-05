// Human user accounts — ~/.gaia/users.json. Distinct from domain/accounts.ts
// (provider credential accounts bound to AGENTS). This is real multi-human
// identity: who is typing, for login + room attribution. Purely additive to
// the existing single-implicit-"user" model — RoomEvent.author stays the
// literal "user" everywhere (zero behavior change to existing checks); a
// logged-in human's id/label ride alongside as optional metadata (see
// UserRoomEvent.humanId/humanLabel in core/types.ts).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { globalPaths } from "../core/paths.js";

export interface HumanUser {
  id: string;
  username: string;
  displayName: string;
  /** Optional per-human filesystem scope. Both fields are present together;
   * absent on legacy/shared users for backwards compatibility. */
  home?: string;
  workspace?: string;
  /** scrypt$<saltHex>$<hashHex>[$<N>] — absent N → legacy cost. */
  passwordHash: string;
  createdAt: string;
}

export type PublicUser = Pick<HumanUser, "id" | "username" | "displayName" | "home" | "workspace" | "createdAt">;

export interface UserWorkspaceOwnership {
  home: string;
  workspace: string;
}

/** Validate + normalize a user-owned filesystem scope. A configured workspace
 * must be an absolute descendant of its absolute home. Traversal components
 * are rejected even when `resolve()` would otherwise erase them: accepting
 * `/safe/../foreign` would make the persisted ownership boundary misleading. */
export function validateUserWorkspaceOwnership(home: string, workspace: string): UserWorkspaceOwnership {
  if (!isAbsolute(home) || !isAbsolute(workspace)) throw new Error("user home and workspace must be absolute paths");
  const hasTraversal = (path: string): boolean => path.split(/[\\/]+/).includes("..");
  if (hasTraversal(home) || hasTraversal(workspace)) throw new Error("user home and workspace must not contain traversal components");

  const normalizedHome = resolve(home);
  const normalizedWorkspace = resolve(workspace);
  const fromHome = relative(normalizedHome, normalizedWorkspace);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error("user workspace must be inside user home");
  }
  return { home: normalizedHome, workspace: normalizedWorkspace };
}

function optionalOwnership(record: { home?: unknown; workspace?: unknown }): UserWorkspaceOwnership | undefined {
  const home = typeof record.home === "string" && record.home.trim() ? record.home.trim() : undefined;
  const workspace = typeof record.workspace === "string" && record.workspace.trim() ? record.workspace.trim() : undefined;
  if (!home && !workspace) return undefined;
  if (!home || !workspace) throw new Error("user home and workspace must be configured together");
  return validateUserWorkspaceOwnership(home, workspace);
}

function usersPath(): string {
  return globalPaths.users();
}

function ensureUsersFile(): void {
  const path = usersPath();
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ users: [] }, null, 2) + "\n", { mode: 0o600 });
}

function readAll(): HumanUser[] {
  const path = usersPath();
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { users?: unknown };
  const list = Array.isArray(raw.users) ? raw.users : [];
  return list.flatMap((entry) => {
    const record = entry as Partial<HumanUser>;
    if (typeof record.id !== "string" || !record.id.trim()) return [];
    if (typeof record.username !== "string" || !record.username.trim()) return [];
    if (typeof record.passwordHash !== "string" || !record.passwordHash.trim()) return [];
    const ownership = optionalOwnership(record);
    return [
      {
        id: record.id.trim(),
        username: record.username.trim(),
        displayName: typeof record.displayName === "string" && record.displayName.trim() ? record.displayName.trim() : record.username.trim(),
        ...(ownership ?? {}),
        passwordHash: record.passwordHash,
        createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date(0).toISOString(),
      },
    ];
  });
}

function writeAll(users: HumanUser[]): void {
  ensureUsersFile();
  writeFileSync(usersPath(), JSON.stringify({ users }, null, 2) + "\n", { mode: 0o600 });
}

function toPublic(user: HumanUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    ...(user.home && user.workspace ? { home: user.home, workspace: user.workspace } : {}),
    createdAt: user.createdAt,
  };
}

const LEGACY_SCRYPT_N = 2 ** 14;
const MIN_SCRYPT_N = 2 ** 15;

/** GAIA_SCRYPT_N → configurable power-of-two work factor; floor enforced. */
function passwordCost(): number {
  const N = Number(process.env.GAIA_SCRYPT_N ?? MIN_SCRYPT_N);
  if (!Number.isSafeInteger(N) || N < MIN_SCRYPT_N || !Number.isInteger(Math.log2(N))) {
    throw new Error("GAIA_SCRYPT_N must be a power of two >= 32768");
  }
  return N;
}

function derivePassword(password: string, salt: string, length: number, N: number): Buffer {
  return scryptSync(password, salt, length, { N, r: 8, p: 1, maxmem: 128 * N * 8 + 1024 * 1024 });
}

function storedPasswordCost(stored: string): number {
  return Number(stored.split("$")[3] ?? LEGACY_SCRYPT_N);
}

function hashPassword(password: string, N = passwordCost()): string {
  const salt = randomBytes(16).toString("hex");
  const hash = derivePassword(password, salt, 64, N).toString("hex");
  return `scrypt$${salt}$${hash}$${N}`;
}

// Missing users take the same KDF + constant-time comparison path as known users.
const DUMMY_PASSWORD_HASH = `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  const actual = derivePassword(password, salt, expected.length, storedPasswordCost(stored));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function listUsers(): PublicUser[] {
  return readAll().map(toPublic);
}

export function findUserByUsername(username: string): HumanUser | undefined {
  const target = username.trim().toLowerCase();
  return readAll().find((user) => user.username.toLowerCase() === target);
}

export function findUserById(id: string): HumanUser | undefined {
  return readAll().find((user) => user.id === id);
}

/** Throws on duplicate username (case-insensitive) or empty password. */
export function createUser(username: string, password: string, displayName?: string, ownership?: UserWorkspaceOwnership): PublicUser {
  const cleanUsername = username.trim();
  if (!cleanUsername) throw new Error("username required");
  if (!password) throw new Error("password required");
  const users = readAll();
  if (users.some((user) => user.username.toLowerCase() === cleanUsername.toLowerCase())) {
    throw new Error(`user '${cleanUsername}' already exists`);
  }
  const normalizedOwnership = ownership ? validateUserWorkspaceOwnership(ownership.home, ownership.workspace) : undefined;
  if (normalizedOwnership && users.some((user) => user.workspace === normalizedOwnership.workspace)) {
    throw new Error(`workspace '${normalizedOwnership.workspace}' is already owned by another user`);
  }
  const user: HumanUser = {
    id: `u_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    username: cleanUsername,
    displayName: displayName?.trim() || cleanUsername,
    ...(normalizedOwnership ?? {}),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeAll(users);
  return toPublic(user);
}

export function removeUser(id: string): boolean {
  const users = readAll();
  const kept = users.filter((user) => user.id !== id);
  if (kept.length === users.length) return false;
  writeAll(kept);
  return true;
}

/** Null on wrong username OR wrong password — never distinguish which, to a caller. */
export function authenticate(username: string, password: string): PublicUser | null {
  const users = readAll();
  const target = username.trim().toLowerCase();
  const user = users.find((entry) => entry.username.toLowerCase() === target);
  const N = passwordCost();
  // Mixed-cost migration → same KDF schedule for every username, including missing.
  const costs = new Set([N, ...users.map((entry) => storedPasswordCost(entry.passwordHash))]);
  let valid = false;
  for (const cost of costs) {
    const real = user !== undefined && storedPasswordCost(user.passwordHash) === cost;
    const matched = verifyPassword(password, real ? user.passwordHash : `${DUMMY_PASSWORD_HASH}$${cost}`);
    if (real && matched) valid = true;
  }
  if (!user || !valid) return null;
  if (storedPasswordCost(user.passwordHash) < N) {
    user.passwordHash = hashPassword(password, N);
    writeAll(users);
  }
  return toPublic(user);
}

// --- sessions ----------------------------------------------------------------
// Stateless signed tokens (HMAC-SHA256), same shape/ethos as edge-proxy.mjs's
// bearer token: no server-side session table, so login survives a daemon
// restart. Tradeoff: logout can't force-revoke a token before it expires
// (30d) — acceptable for a first cut, tighten later if needed.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionSecret(): Buffer {
  const path = globalPaths.sessionSecret();
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(path, secret.toString("hex") + "\n", { mode: 0o600 });
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

/** `<userId>.<expiryEpochMs>.<hmacHex>`, base64url-wrapped for safe cookie transport. */
export function issueSessionToken(userId: string): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  const token = `${payload}.${sign(payload)}`;
  return Buffer.from(token, "utf8").toString("base64url");
}

/** Verifies signature + expiry, returns the user (re-reads from disk — cheap,
 * tiny file, and a removed/renamed user must stop authenticating immediately). */
export function verifySessionToken(token: string): PublicUser | null {
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const lastDot = raw.lastIndexOf(".");
  if (lastDot < 0) return null;
  const payload = raw.slice(0, lastDot);
  const signature = raw.slice(lastDot + 1);
  const expected = sign(payload);
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  const [userId, expiryStr] = payload.split(".");
  const expiry = Number(expiryStr);
  if (!userId || !Number.isFinite(expiry) || expiry < Date.now()) return null;
  const user = findUserById(userId);
  return user ? toPublic(user) : null;
}
