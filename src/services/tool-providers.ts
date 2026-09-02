// Daemon-side implementations for the harness ToolProviders port. The harness
// imports only the port; this composition-side adapter owns service imports.
import { createArtifact, listArtifacts, readArtifact, updateArtifact } from "./artifacts.js";
import { compressCaryll, expandCaryll } from "./caryll.js";
import { searchWeb } from "./web-search.js";
import { fetchWeb } from "./web-fetch.js";
import type { ToolProviders } from "../harness/protocol.js";

export function createToolProviders(): ToolProviders {
  return {
    artifacts: {
      list: listArtifacts,
      read: async (location, artifactId) => {
        const artifact = await readArtifact(location, artifactId);
        return { manifest: artifact.manifest, payload: Buffer.from(artifact.payload).toString("utf8") };
      },
      create: createArtifact,
      update: updateArtifact,
    },
    web: { search: searchWeb, fetch: fetchWeb },
    caryll: {
      compress: async (text) => compressCaryll(text),
      expand: async (text) => expandCaryll(text),
    },
  };
}
