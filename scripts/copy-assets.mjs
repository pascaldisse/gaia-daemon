import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/personas", { recursive: true });
await cp("src/personas/prompts", "dist/personas/prompts", { recursive: true });
