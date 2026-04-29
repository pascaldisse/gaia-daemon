import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, getAgentDir, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { PersonaId } from "../personas/types.js";
import { PERSONAS } from "../personas/types.js";
import { renderStartupMemory } from "../memory/render.js";
import type { MemoryStore } from "../memory/memory-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readPersonaPrompt(persona: PersonaId): Promise<string> {
  const file = PERSONAS[persona].promptFile;
  return readFile(join(__dirname, "..", "personas", "prompts", file), "utf8");
}

export async function buildPersonaSystemPrompt(persona: PersonaId, memoryStore: MemoryStore): Promise<string> {
  const [prompt, memory] = await Promise.all([readPersonaPrompt(persona), memoryStore.snapshot(persona)]);
  return `${prompt.trim()}\n\n---\n\n${renderStartupMemory(memory)}\n\n---\n\nYou are running inside GAIA, a small standalone CLI wrapper over the Pi SDK. Pi coding tools may be available. Be transparent about tool use and concise in normal conversation.`;
}

export async function createPersonaResourceLoader(options: {
  cwd: string;
  persona: PersonaId;
  memoryStore: MemoryStore;
  extensionFactories?: ExtensionFactory[];
}) {
  const systemPrompt = await buildPersonaSystemPrompt(options.persona, options.memoryStore);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: options.extensionFactories ?? [],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}
