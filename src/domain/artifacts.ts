export const ARTIFACT_KINDS = ["html", "json", "design"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactManifest {
  readonly version: 1;
  readonly artifactId: string;
  readonly roomId: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredArtifact {
  readonly manifest: ArtifactManifest;
  readonly payload: Uint8Array;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}
