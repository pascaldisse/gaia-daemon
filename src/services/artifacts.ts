import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { newId } from "../core/ids.js";
import { workspacePaths } from "../core/paths.js";
import { ensureDir, readJson, writeBytesAtomic, writeJsonAtomic } from "../core/store.js";
import { isArtifactKind, type ArtifactKind, type ArtifactManifest, type StoredArtifact } from "../domain/artifacts.js";

export interface ArtifactLocation {
  rootDir: string;
  roomId: string;
}

export interface CreateArtifactInput {
  name: string;
  kind: ArtifactKind;
  mediaType: string;
  payload: string | Uint8Array;
}

export interface UpdateArtifactInput {
  name?: string;
  kind?: ArtifactKind;
  mediaType?: string;
  payload?: string | Uint8Array;
}

export interface ArtifactDependencies {
  id?: () => string;
  now?: () => string;
}

function requireArtifactId(artifactId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(artifactId)) throw new Error(`invalid artifact id: ${artifactId}`);
  return artifactId;
}

function requireText(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function requireKind(value: unknown): ArtifactKind {
  if (!isArtifactKind(value)) throw new Error(`invalid artifact kind: ${String(value)}`);
  return value;
}

function payloadBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? Buffer.from(payload, "utf8") : Uint8Array.from(payload);
}

function digest(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function parseManifest(raw: unknown, expected: { artifactId: string; roomId: string }): ArtifactManifest {
  if (!raw || typeof raw !== "object") throw new Error(`invalid artifact manifest: ${expected.artifactId}`);
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.artifactId !== expected.artifactId ||
    value.roomId !== expected.roomId ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !isArtifactKind(value.kind) ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.trim() ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.createdAt !== "string" ||
    !value.createdAt ||
    typeof value.updatedAt !== "string" ||
    !value.updatedAt
  ) {
    throw new Error(`invalid artifact manifest: ${expected.artifactId}`);
  }
  return value as unknown as ArtifactManifest;
}

async function manifestAt(location: ArtifactLocation, artifactId: string): Promise<ArtifactManifest> {
  const id = requireArtifactId(artifactId);
  const raw = await readJson(workspacePaths.roomArtifactManifest(location.rootDir, location.roomId, id));
  if (raw === undefined) throw new Error(`artifact not found: ${id}`);
  return parseManifest(raw, { artifactId: id, roomId: location.roomId });
}

/** Create one ledger entry at artifacts/<artifactId>/{manifest.json,payload}. */
export async function createArtifact(
  location: ArtifactLocation,
  input: CreateArtifactInput,
  dependencies: ArtifactDependencies = {},
): Promise<ArtifactManifest> {
  const artifactId = requireArtifactId((dependencies.id ?? (() => newId("artifact")))());
  const name = requireText(input.name, "name");
  const kind = requireKind(input.kind);
  const mediaType = requireText(input.mediaType, "mediaType");
  const payload = payloadBytes(input.payload);
  const at = (dependencies.now ?? (() => new Date().toISOString()))();
  const manifest: ArtifactManifest = {
    version: 1,
    artifactId,
    roomId: location.roomId,
    name,
    kind,
    mediaType,
    bytes: payload.byteLength,
    sha256: digest(payload),
    createdAt: at,
    updatedAt: at,
  };

  const ledgerDir = workspacePaths.roomArtifactsDir(location.rootDir, location.roomId);
  const artifactDir = workspacePaths.roomArtifactDir(location.rootDir, location.roomId, artifactId);
  await ensureDir(ledgerDir);
  await mkdir(artifactDir);
  try {
    await writeBytesAtomic(workspacePaths.roomArtifactPayload(location.rootDir, location.roomId, artifactId), payload);
    await writeJsonAtomic(workspacePaths.roomArtifactManifest(location.rootDir, location.roomId, artifactId), manifest);
    return manifest;
  } catch (error) {
    await rm(artifactDir, { recursive: true, force: true });
    throw error;
  }
}

export async function updateArtifact(
  location: ArtifactLocation,
  artifactId: string,
  input: UpdateArtifactInput,
  dependencies: Pick<ArtifactDependencies, "now"> = {},
): Promise<ArtifactManifest> {
  const current = await readArtifact(location, artifactId);
  const payload = input.payload === undefined ? current.payload : payloadBytes(input.payload);
  const manifest: ArtifactManifest = {
    ...current.manifest,
    name: input.name === undefined ? current.manifest.name : requireText(input.name, "name"),
    kind: input.kind === undefined ? current.manifest.kind : requireKind(input.kind),
    mediaType: input.mediaType === undefined ? current.manifest.mediaType : requireText(input.mediaType, "mediaType"),
    bytes: payload.byteLength,
    sha256: digest(payload),
    updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
  };

  if (input.payload !== undefined) {
    await writeBytesAtomic(workspacePaths.roomArtifactPayload(location.rootDir, location.roomId, artifactId), payload);
  }
  await writeJsonAtomic(workspacePaths.roomArtifactManifest(location.rootDir, location.roomId, artifactId), manifest);
  return manifest;
}

export async function listArtifacts(location: ArtifactLocation): Promise<ArtifactManifest[]> {
  const ledgerDir = workspacePaths.roomArtifactsDir(location.rootDir, location.roomId);
  let entries;
  try {
    entries = await readdir(ledgerDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(ids.map((artifactId) => manifestAt(location, artifactId)));
}

export async function readArtifact(location: ArtifactLocation, artifactId: string): Promise<StoredArtifact> {
  const id = requireArtifactId(artifactId);
  const manifest = await manifestAt(location, id);
  let payload: Uint8Array;
  try {
    payload = await readFile(workspacePaths.roomArtifactPayload(location.rootDir, location.roomId, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`artifact payload not found: ${id}`);
    throw error;
  }
  if (payload.byteLength !== manifest.bytes || digest(payload) !== manifest.sha256) {
    throw new Error(`artifact payload integrity check failed: ${id}`);
  }
  return { manifest, payload };
}
