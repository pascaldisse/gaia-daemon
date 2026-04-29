export interface GaiaArtifact {
  kind: "html" | "image" | "data";
  path: string;
  title?: string;
}

export interface ArtifactWriter {
  writeArtifact(artifact: Omit<GaiaArtifact, "path"> & { content: string }): Promise<GaiaArtifact>;
}

// Future seam only. V1 does not implement Python visualization or generated HTML artifact UI.
