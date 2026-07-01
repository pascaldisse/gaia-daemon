import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

export async function createTempDir(prefix = "gaia2-test-"): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}
