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
