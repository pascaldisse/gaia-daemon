// Codex-compatible pet packages and durable workspace binding snapshots.
// Package names and spritesheet paths are validated here once; both the slash
// command and HTTP asset route use this same domain implementation.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { workspacePaths } from "../core/paths.js";
import { readJson } from "../core/store.js";
import type { PetBinding } from "../core/types.js";

export const DEFAULT_PET_NAME = "gaia";
const PET_PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
}

export interface LoadedPet {
  manifest: PetManifest;
  spritesheetFile: string;
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isValidPetPackageName(name: string): boolean {
  return PET_PACKAGE_NAME.test(name);
}

export function codexPetsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "pets");
}

/** Load one Codex-compatible pet package without exposing its filesystem path. */
export async function loadPet(name = DEFAULT_PET_NAME, petsRoot = codexPetsRoot()): Promise<LoadedPet> {
  if (!isValidPetPackageName(name)) throw new Error("Invalid pet name");
  const packageDir = join(petsRoot, name);
  const manifestFile = join(packageDir, "pet.json");
  const raw = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
  const fields = ["id", "displayName", "description", "spritesheetPath"] as const;
  for (const field of fields) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) throw new Error(`Invalid pet manifest field '${field}'`);
  }
  const manifest: PetManifest = {
    id: raw.id as string,
    displayName: raw.displayName as string,
    description: raw.description as string,
    spritesheetPath: raw.spritesheetPath as string,
  };
  const spritesheetFile = resolve(packageDir, manifest.spritesheetPath);
  const [realPackageDir, realSpritesheetFile] = await Promise.all([realpath(packageDir), realpath(spritesheetFile)]);
  if (!pathInside(realSpritesheetFile, realPackageDir)) throw new Error("Pet spritesheet must stay inside its package");
  if (!(await stat(realSpritesheetFile)).isFile()) throw new Error("Pet spritesheet is not a file");
  return { manifest, spritesheetFile: realSpritesheetFile };
}

/** Normalize the RoomState pet block. Malformed/unsafe legacy data is dropped;
 * there is deliberately no migration from the retired localStorage setting. */
export function normalizePetBindings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const bindings = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => AGENT_ID.test(entry[0]) && typeof entry[1] === "string" && isValidPetPackageName(entry[1]),
    ),
  );
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

/** Snapshot every room+agent binding in a workspace directly from durable
 * RoomState. This is the shell seed; it never depends on which room has an SSE
 * subscription or a resident RoomService. */
export async function listWorkspacePetBindings(workspaceId: string, workspaceRoot: string): Promise<PetBinding[]> {
  let roomIds: string[];
  try {
    roomIds = await readdir(workspacePaths.roomsDir(workspaceRoot));
  } catch {
    return [];
  }
  const bindings: PetBinding[] = [];
  for (const roomId of roomIds.sort()) {
    try {
      const raw = (await readJson(workspacePaths.roomState(workspaceRoot, roomId))) as { petBindings?: unknown } | undefined;
      const roomBindings = normalizePetBindings(raw?.petBindings);
      if (!roomBindings) continue;
      for (const [agentId, packageName] of Object.entries(roomBindings).sort(([a], [b]) => a.localeCompare(b))) {
        bindings.push({ workspaceId, roomId, agentId, package: packageName });
      }
    } catch {
      // One unreadable room must not remove every other live pet from the shell.
    }
  }
  return bindings;
}
