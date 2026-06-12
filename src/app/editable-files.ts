import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathId, pathInside, writeFileAtomic } from "../lib/fs.js";
import { gaiaHome } from "../workspace/workspace-loader.js";
import type { Workspace } from "../workspace/types.js";

export type EditableScope = "global" | "workspace";

// What a file *is*, computed where the directory layout is known (here), so
// the frontend can group files without parsing label paths.
export type EditableCategory = "general" | "voice" | "config" | "persona" | "memory";

export interface EditableFileDescriptor {
  id: string;
  scope: EditableScope;
  label: string;
  path: string;
  kind: "markdown" | "json" | "text";
  /** Owning agent for files under the global agents directory. */
  agentId?: string;
  category?: EditableCategory;
}

export interface EditableFileContent extends EditableFileDescriptor {
  content: string;
}

function fileId(scope: EditableScope, path: string): string {
  return `${scope}_${pathId(path, 18)}`;
}

function kindFor(path: string): EditableFileDescriptor["kind"] {
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  return "text";
}

function labelFor(path: string, root: string): string {
  const rel = relative(root, path);
  return rel || path;
}

async function walkEditable(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json")))
    .map((entry) => join(entry.parentPath, entry.name));
}

function globalCategory(path: string, home: string): Pick<EditableFileDescriptor, "agentId" | "category"> {
  const rel = relative(home, path);
  const parts = rel.split(sep);
  if (parts[0] === "agents" && parts.length > 2) {
    const file = parts[parts.length - 1];
    const category = file === "agent.json" ? "config" : file === "MEMORY.md" ? "memory" : "persona";
    return { agentId: parts[1], category };
  }
  return { category: rel === "voice.json" ? "voice" : "general" };
}

async function descriptor(scope: EditableScope, path: string, labelRoot: string): Promise<EditableFileDescriptor | undefined> {
  if (!existsSync(path)) return undefined;
  const info = await stat(path);
  if (!info.isFile()) return undefined;
  return {
    id: fileId(scope, path),
    scope,
    label: labelFor(path, labelRoot),
    path,
    kind: kindFor(path),
    ...(scope === "global" ? globalCategory(path, labelRoot) : {}),
  };
}

export class EditableFileRegistry {
  constructor(private readonly workspaceById: (id: string) => Promise<Workspace | undefined>) {}

  async listGlobal(): Promise<EditableFileDescriptor[]> {
    const home = gaiaHome();
    const files = [join(home, "app.json"), join(home, "voice.json"), ...(await walkEditable(join(home, "agents")))];
    const descriptors = await Promise.all(files.map((path) => descriptor("global", path, home)));
    return descriptors.filter((item): item is EditableFileDescriptor => Boolean(item)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async listWorkspace(workspaceId: string): Promise<EditableFileDescriptor[]> {
    const workspace = await this.workspaceById(workspaceId);
    if (!workspace) return [];

    const files = [join(workspace.rootDir, "AGENTS.md"), workspace.configPath];
    files.push(...(await walkEditable(workspace.agentsOverrideDir)));
    files.push(...(await walkEditable(join(workspace.dir, "skills"))));

    const descriptors = await Promise.all(files.map((path) => descriptor("workspace", path, workspace.rootDir)));
    return descriptors.filter((item): item is EditableFileDescriptor => Boolean(item)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async read(fileId: string, workspaceId?: string): Promise<EditableFileContent> {
    const found = await this.find(fileId, workspaceId);
    if (!found) throw new Error("Editable file not found");
    return { ...found, content: await readFile(found.path, "utf8") };
  }

  async write(fileId: string, content: string, workspaceId?: string): Promise<EditableFileContent> {
    const found = await this.find(fileId, workspaceId);
    if (!found) throw new Error("Editable file not found");
    await writeFileAtomic(found.path, content);
    return { ...found, content };
  }

  private async find(fileId: string, workspaceId?: string): Promise<EditableFileDescriptor | undefined> {
    const globalFiles = await this.listGlobal();
    const globalMatch = globalFiles.find((file) => file.id === fileId);
    if (globalMatch) {
      if (!pathInside(globalMatch.path, gaiaHome())) throw new Error("Editable file escaped GAIA home");
      return globalMatch;
    }

    if (!workspaceId) return undefined;
    const workspaceFiles = await this.listWorkspace(workspaceId);
    const workspaceMatch = workspaceFiles.find((file) => file.id === fileId);
    if (!workspaceMatch) return undefined;
    const workspace = await this.workspaceById(workspaceId);
    if (!workspace || !pathInside(workspaceMatch.path, workspace.rootDir)) throw new Error("Editable file escaped workspace");
    return workspaceMatch;
  }
}
