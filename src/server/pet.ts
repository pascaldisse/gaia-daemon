import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_PET_NAME = "gaia";

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

export function codexPetsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "pets");
}

/** Load one Codex-compatible pet package without exposing its filesystem path. */
export async function loadPet(name = DEFAULT_PET_NAME, petsRoot = codexPetsRoot()): Promise<LoadedPet> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error("Invalid pet name");
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
