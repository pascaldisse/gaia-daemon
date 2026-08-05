import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gaiaHome } from "../core/paths.js";
import { newId } from "../core/ids.js";
import { readJson, writeJsonAtomic } from "../core/store.js";

export type WorkspaceIdentityId = "FENYX" | "PERSONAL" | "PALOPTIC";
export type CredentialStatus = "unknown" | "stored" | "missing" | "error";

export interface WorkspaceIdentity {
  id: WorkspaceIdentityId;
  label: string;
  description: string;
  allowedProviders: string[];
  memoryScope: string;
}

export interface CredentialRecord {
  id: string;
  workspaceId: WorkspaceIdentityId;
  provider: string;
  capability: string;
  account?: string;
  scopes: string[];
  status: CredentialStatus;
  secretBackend: "macos-keychain" | "metadata-only";
  secretRef: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  failureReason?: string;
}

export interface KeymakerState {
  workspaces: WorkspaceIdentity[];
  credentials: CredentialRecord[];
  roomBindings: Record<string, WorkspaceIdentityId>;
  audit: { id: string; at: string; action: string; workspaceId?: WorkspaceIdentityId; credentialId?: string; detail?: string }[];
}

const DEFAULT_WORKSPACES: WorkspaceIdentity[] = [
  {
    id: "FENYX",
    label: "FENYX",
    description: "Company workspace; company-paid models and GTM credentials only.",
    allowedProviders: ["hubspot", "n8n", "openai", "anthropic", "google", "slack"],
    memoryScope: "workspace/FENYX",
  },
  {
    id: "PERSONAL",
    label: "PERSONAL",
    description: "Private workspace; never use company-paid accounts by default.",
    allowedProviders: ["openai", "anthropic", "google", "replicate", "brave"],
    memoryScope: "workspace/PERSONAL",
  },
  {
    id: "PALOPTIC",
    label: "PALOPTIC",
    description: "Paloptic workspace; Paloptic-owned keys, accounts, and memory scope.",
    allowedProviders: ["hubspot", "n8n", "openai", "anthropic", "google", "slack"],
    memoryScope: "workspace/PALOPTIC",
  },
];

function keymakerDir(): string {
  return join(gaiaHome(), "keymaker");
}

function statePath(): string {
  return join(keymakerDir(), "state.json");
}

function blankState(): KeymakerState {
  return { workspaces: DEFAULT_WORKSPACES, credentials: [], roomBindings: {}, audit: [] };
}

export function normalizeWorkspaceId(value: string): WorkspaceIdentityId | undefined {
  const upper = value.trim().toUpperCase();
  return upper === "FENYX" || upper === "PERSONAL" || upper === "PALOPTIC" ? upper : undefined;
}

function safePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

async function ensureKeymakerDir(): Promise<void> {
  await mkdir(keymakerDir(), { recursive: true, mode: 0o700 });
}

export async function readKeymakerState(): Promise<KeymakerState> {
  await ensureKeymakerDir();
  const raw = existsSync(statePath()) ? ((await readJson(statePath())) as Partial<KeymakerState> | undefined) : undefined;
  const state: KeymakerState = {
    workspaces: Array.isArray(raw?.workspaces) ? (raw.workspaces as WorkspaceIdentity[]) : DEFAULT_WORKSPACES,
    credentials: Array.isArray(raw?.credentials) ? (raw.credentials as CredentialRecord[]) : [],
    roomBindings: raw?.roomBindings && typeof raw.roomBindings === "object" ? (raw.roomBindings as Record<string, WorkspaceIdentityId>) : {},
    audit: Array.isArray(raw?.audit) ? raw.audit.slice(-500) as KeymakerState["audit"] : [],
  };
  return state;
}

async function writeKeymakerState(state: KeymakerState): Promise<void> {
  await ensureKeymakerDir();
  await writeJsonAtomic(statePath(), { ...state, audit: state.audit.slice(-500) });
}

function audit(state: KeymakerState, action: string, fields: Partial<KeymakerState["audit"][number]> = {}): void {
  state.audit.push({ id: newId("audit"), at: new Date().toISOString(), action, ...fields });
}

function keychainService(): string {
  return "gaia:keymaker";
}

function keychainAccount(credentialId: string): string {
  return `credential:${credentialId}`;
}

function storeSecret(credentialId: string, secret: string): { ok: true } | { ok: false; error: string } {
  if (process.platform !== "darwin") return { ok: false, error: "macOS Keychain storage is only available on darwin in this build" };
  const result = spawnSync("security", ["add-generic-password", "-U", "-s", keychainService(), "-a", keychainAccount(credentialId), "-w", secret], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return { ok: true };
  return { ok: false, error: (result.stderr || result.stdout || `security exited ${result.status}`).trim() };
}

function hasSecret(credentialId: string): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("security", ["find-generic-password", "-s", keychainService(), "-a", keychainAccount(credentialId)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

export async function setRoomWorkspaceBinding(roomId: string, workspaceId: WorkspaceIdentityId): Promise<KeymakerState> {
  const state = await readKeymakerState();
  state.roomBindings[roomId] = workspaceId;
  audit(state, "workspace.bind-room", { workspaceId, detail: roomId });
  await writeKeymakerState(state);
  return state;
}

export async function importCredential(input: {
  workspaceId: WorkspaceIdentityId;
  provider: string;
  capability: string;
  account?: string;
  scopes?: string[];
  secret?: string;
}): Promise<{ credential: CredentialRecord; state: KeymakerState }> {
  const state = await readKeymakerState();
  const now = new Date().toISOString();
  const id = newId("cred");
  const provider = safePart(input.provider);
  const capability = safePart(input.capability);
  const secretRef = `${input.workspaceId}/${provider}/${capability}/${id}`;
  const credential: CredentialRecord = {
    id,
    workspaceId: input.workspaceId,
    provider,
    capability,
    ...(input.account?.trim() ? { account: input.account.trim() } : {}),
    scopes: input.scopes ?? [],
    status: input.secret ? "stored" : "missing",
    secretBackend: input.secret ? "macos-keychain" : "metadata-only",
    secretRef,
    createdAt: now,
    updatedAt: now,
  };
  if (input.secret) {
    const stored = storeSecret(id, input.secret);
    if (!stored.ok) {
      credential.status = "error";
      credential.failureReason = stored.error;
      credential.secretBackend = "metadata-only";
    }
  }
  state.credentials.push(credential);
  audit(state, "credential.import", { workspaceId: credential.workspaceId, credentialId: id, detail: `${provider}:${capability}` });
  await writeKeymakerState(state);
  return { credential, state };
}

export async function checkCredential(credentialId: string): Promise<{ credential: CredentialRecord; state: KeymakerState }> {
  const state = await readKeymakerState();
  const credential = state.credentials.find((item) => item.id === credentialId);
  if (!credential) throw new Error(`Unknown credential: ${credentialId}`);
  credential.lastCheckedAt = new Date().toISOString();
  if (credential.secretBackend === "macos-keychain" && hasSecret(credential.id)) {
    credential.status = "stored";
    delete credential.failureReason;
  } else if (credential.secretBackend === "macos-keychain") {
    credential.status = "missing";
    credential.failureReason = "No matching Keychain item";
  } else {
    credential.status = "missing";
    credential.failureReason = "Metadata only; no secret stored";
  }
  credential.updatedAt = credential.lastCheckedAt;
  audit(state, "credential.check", { workspaceId: credential.workspaceId, credentialId: credential.id, detail: credential.status });
  await writeKeymakerState(state);
  return { credential, state };
}
