import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { gaiaHome, workspacePath } from "../workspace/workspace-loader.js";

export interface WorkspaceRecord {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: string;
  isInitialized: boolean;
}

interface AppConfig {
  recentWorkspaces?: WorkspaceRecord[];
}

function appConfigPath(home = gaiaHome()): string {
  return join(home, "app.json");
}

function workspaceId(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

function workspaceName(path: string): string {
  const parts = resolve(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizeRecord(path: string, lastOpenedAt = new Date().toISOString()): WorkspaceRecord {
  const resolved = resolve(path);
  return {
    id: workspaceId(resolved),
    path: resolved,
    name: workspaceName(resolved),
    lastOpenedAt,
    isInitialized: existsSync(workspacePath(resolved)),
  };
}

async function readConfig(path: string): Promise<AppConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as AppConfig;
  } catch {
    return {};
  }
}

async function writeConfig(path: string, config: AppConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export class WorkspaceRegistry {
  private readonly path: string;

  constructor(home = gaiaHome()) {
    this.path = appConfigPath(home);
  }

  async list(): Promise<WorkspaceRecord[]> {
    const config = await readConfig(this.path);
    return (config.recentWorkspaces ?? [])
      .map((record) => normalizeRecord(record.path, record.lastOpenedAt))
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async add(path: string): Promise<WorkspaceRecord> {
    const record = normalizeRecord(path);
    const config = await readConfig(this.path);
    const existing = config.recentWorkspaces ?? [];
    const next = [record, ...existing.filter((item) => item.id !== record.id)].slice(0, 30);
    await writeConfig(this.path, { ...config, recentWorkspaces: next });
    return record;
  }

  async find(id: string): Promise<WorkspaceRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }
}
