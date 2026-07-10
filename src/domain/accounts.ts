// Named provider accounts — ~/.gaia/accounts.json. Harness-BLIND records: the
// daemon stores each account as an opaque credential bag that only the owning
// harness's spec can interpret (HarnessSpec.accounts.env). Agents bind with
// AgentDef.account; RunnerHost injects the wiring uniformly at spawn. Read
// fresh (sync) on every call: the file is tiny, spawn paths are synchronous,
// and a settings edit must take effect on the next turn without a daemon
// bounce. Missing file = no accounts; a MALFORMED file throws loudly — a torn
// credential store must never quietly demote an agent to the shared login.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { globalPaths } from "../core/paths.js";

export interface AccountRecord {
  /** Unique id (what AgentDef.account references). */
  id: string;
  /** Owning harness id — only that harness's agents may bind to this account. */
  harness: string;
  label?: string;
  /** Opaque credential bag; field meaning is the owning spec's (accounts.fields). */
  credentials: Record<string, string>;
}

export function accountsPath(): string {
  return globalPaths.accounts();
}

/** Seed an empty store so the settings UI lists the file. Never overwrites. */
export function ensureAccountsFile(): void {
  const path = accountsPath();
  if (existsSync(path)) return;
  writeFileSync(path, JSON.stringify({ accounts: [] }, null, 2) + "\n", { mode: 0o600 });
}

export function listAccounts(): AccountRecord[] {
  const path = accountsPath();
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { accounts?: unknown };
  const list = Array.isArray(raw.accounts) ? raw.accounts : [];
  return list.flatMap((entry) => {
    const record = entry as Partial<AccountRecord>;
    if (typeof record.id !== "string" || !record.id.trim()) return [];
    if (typeof record.harness !== "string" || !record.harness.trim()) return [];
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.credentials ?? {})) {
      if (typeof value === "string") credentials[key] = value;
    }
    return [
      {
        id: record.id.trim(),
        harness: record.harness.trim(),
        ...(typeof record.label === "string" && record.label.trim() ? { label: record.label.trim() } : {}),
        credentials,
      },
    ];
  });
}

export function findAccount(id: string): AccountRecord | undefined {
  return listAccounts().find((account) => account.id === id);
}

/** Redacted view for clients — never includes the credential bag. */
export function redactedAccounts(): Array<{ id: string; harness: string; label?: string }> {
  return listAccounts().map(({ id, harness, label }) => ({ id, harness, ...(label ? { label } : {}) }));
}

/** First free id: slugified label ("Work Account" -> "work-account") when given
 * and unused, else `${harness}-2`, `${harness}-3`, ... skipping taken ids. */
export function newAccountId(harness: string, label?: string): string {
  const taken = new Set(listAccounts().map((account) => account.id));
  if (label) {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug && !taken.has(slug)) return slug;
  }
  for (let n = 2; ; n++) {
    const candidate = `${harness}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addAccount(record: AccountRecord): void {
  ensureAccountsFile();
  const path = accountsPath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as { accounts?: unknown };
  const list = Array.isArray(raw.accounts) ? (raw.accounts as unknown[]) : [];
  if (list.some((entry) => (entry as Partial<AccountRecord>)?.id === record.id)) {
    throw new Error(`account '${record.id}' already exists`);
  }
  list.push(record);
  writeFileSync(path, JSON.stringify({ ...raw, accounts: list }, null, 2) + "\n", { mode: 0o600 });
}

export function removeAccount(id: string): boolean {
  const path = accountsPath();
  if (!existsSync(path)) return false;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { accounts?: unknown };
  const list = Array.isArray(raw.accounts) ? (raw.accounts as unknown[]) : [];
  const kept = list.filter((entry) => (entry as Partial<AccountRecord>)?.id !== id);
  if (kept.length === list.length) return false;
  writeFileSync(path, JSON.stringify({ ...raw, accounts: kept }, null, 2) + "\n", { mode: 0o600 });
  return true;
}
